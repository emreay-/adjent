/**
 * The orchestrator: one tick = collect → quota → assess → fit → per-agent
 * burns → consistency residual → alarms. Owns the single AppState snapshot
 * (docs/ARCHITECTURE.md `state.ts`).
 */
import { EventEmitter } from 'node:events';
import type {
  Agent,
  AgentBurn,
  Alarm,
  AppState,
  Backend,
  Confidence,
  FireLog,
  QuotaWindow,
} from './model/types.js';
import { emptyFireLog } from './model/types.js';
import type { ProviderAdapter } from './providers/provider.js';
import { UsageLedger } from './quota/ledger.js';
import { ExchangeRateFit, type FitResult } from './quota/fit.js';
import { WindowAssessor } from './quota/assess.js';
import { evaluate } from './rules/evaluate.js';
import { DEFAULT_CONFIG, type AlarmConfig } from './rules/config.js';
import { SinkRouter } from './sinks/sink.js';

/** τ — the measurement lookback for per-agent burn. Not W (GLOSSARY). */
const AGENT_BURN_LOOKBACK_MS = 10 * 60_000;
/** EWMA half-life for the consistency residual ε. */
const EPSILON_HALF_LIFE_MS = 15 * 60_000;

export interface MonitorOptions {
  providers: ProviderAdapter[];
  config?: AlarmConfig;
  now?: () => number;
}

export class Monitor extends EventEmitter {
  private readonly providers: ProviderAdapter[];
  private readonly now: () => number;
  private config: AlarmConfig;

  readonly ledger = new UsageLedger();
  private readonly fits = new Map<string, ExchangeRateFit>(); // per binding-capable backend window
  private readonly assessor = new WindowAssessor();
  private readonly fireLog: FireLog = emptyFireLog();
  readonly router: SinkRouter;

  private epsilonEwma: number | null = null;
  private epsilonAt: number | null = null;
  private lastTierByBackend = new Map<string, string | null>();
  private lastState: AppState | null = null;

  constructor(opts: MonitorOptions) {
    super();
    this.providers = opts.providers;
    this.now = opts.now ?? Date.now;
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.router = new SinkRouter(this.config.routing);
  }

  setConfig(config: AlarmConfig): void {
    this.config = config;
    this.router.setRouting(config.routing);
  }

  get state(): AppState | null {
    return this.lastState;
  }

  async tick(): Promise<AppState> {
    const now = this.now();
    const backends: Backend[] = [];
    const agents: Agent[] = [];
    const windows: QuotaWindow[] = [];

    for (const p of this.providers) {
      try {
        const b = await p.detect();
        if (!b) continue;

        // Plan-change watch: tier string changed → re-bootstrap that backend's fits.
        const prevTier = this.lastTierByBackend.get(p.id);
        if (prevTier !== undefined && prevTier !== b.rateLimitTier) {
          for (const [key, fit] of this.fits) if (key.startsWith(`${p.id}:`)) fit.rebootstrap();
        }
        this.lastTierByBackend.set(p.id, b.rateLimitTier);

        const events = await p.collectUsage();
        this.ledger.add(events);
        backends.push(b);
        agents.push(...(await p.listAgents()));
        windows.push(...(await p.quota()));
      } catch (e) {
        // Degrade one provider, never the app.
        backends.push({
          id: p.id,
          displayName: p.id,
          version: null,
          plan: null,
          rateLimitTier: null,
          health: 'degraded',
          healthDetail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Feed the fit one poll per short (5h-class) window per backend — the
    // window whose Δu is most informative at our cadence.
    let fitResult: FitResult | null = null;
    for (const w of windows) {
      if (w.windowMinutes > 0 && w.windowMinutes <= 600 && w.scope === null) {
        const key = `${w.backend}:${w.key}`;
        const fit = this.fits.get(key) ?? new ExchangeRateFit();
        this.fits.set(key, fit);
        fit.observePoll(w, this.ledger);
        const r = fit.fit();
        if (r && (!fitResult || r.confidence === 'high')) fitResult = r;
      }
    }

    const assessments = this.assessor.assess(windows, now);

    // Per-agent burn: r_a = priced consumption over τ, scaled to an hour. Derived — render with ≈.
    const agentBurns: AgentBurn[] = [];
    if (fitResult) {
      const anyFit = [...this.fits.values()].find((f) => f.bootstrapped);
      if (anyFit) {
        for (const a of agents) {
          const pct = anyFit.priceAgentConsumption(this.ledger, a.id, now - AGENT_BURN_LOOKBACK_MS, now, fitResult);
          const pctPerHour = (pct * 3600_000) / AGENT_BURN_LOOKBACK_MS;
          if (pctPerHour > 0.01) agentBurns.push({ agentId: a.id, pctPerHour, confidence: fitResult.confidence });
        }
      }
    }

    // Consistency residual ε: gross burn per the vendor vs gross summed over
    // agents (GLOSSARY § the free consistency check). Uses the binding short
    // window's measured rate as the vendor side.
    this.updateEpsilon(assessments, agentBurns, now);

    const fitConfidence: Confidence = fitResult?.confidence ?? 'low';
    const state: AppState = {
      generatedAt: now,
      backends,
      agents: agents.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      windows: assessments,
      agentBurns: agentBurns.sort((a, b) => b.pctPerHour - a.pctPerHour),
      epsilon: this.epsilonEwma,
      fitConfidence,
    };
    this.lastState = state;

    const alarms: Alarm[] = evaluate(state, this.config.rules, this.fireLog, now);
    if (alarms.length > 0) {
      await this.router.route(alarms);
      for (const a of alarms) this.emit('alarm', a);
    }
    this.emit('state', state);
    return state;
  }

  private updateEpsilon(assessments: AppState['windows'], burns: AgentBurn[], now: number): void {
    const binding = assessments.find((a) => a.binding && a.burn !== null);
    if (!binding || binding.burn === null) return;
    const vendorRate = binding.burn.pctPerHour; // net; agents' side omits aging-out too over short τ,
    const agentRate = burns.reduce((s, b) => s + b.pctPerHour, 0); // so compare directly and let the EWMA absorb edges
    const eps = Math.abs(vendorRate - agentRate);
    const alpha = this.epsilonAt === null ? 1 : 1 - Math.pow(2, -(now - this.epsilonAt) / EPSILON_HALF_LIFE_MS);
    this.epsilonEwma = this.epsilonEwma === null ? eps : alpha * eps + (1 - alpha) * this.epsilonEwma;
    this.epsilonAt = now;
  }
}
