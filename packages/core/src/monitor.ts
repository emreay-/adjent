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
import { STORE_VERSION, Store, type HistorySample } from './persist.js';

/** τ — the measurement lookback for per-agent burn. Not W (GLOSSARY). */
const AGENT_BURN_LOOKBACK_MS = 10 * 60_000;
/** EWMA half-life for the consistency residual ε. */
const EPSILON_HALF_LIFE_MS = 15 * 60_000;

export interface MonitorOptions {
  providers: ProviderAdapter[];
  config?: AlarmConfig;
  now?: () => number;
  /** Durable state. Pass null to run entirely in memory (tests). */
  store?: Store | null;
}

/** Write a utilization sample only on change, or every this often. */
const HISTORY_MIN_INTERVAL_MS = 5 * 60_000;
/** How often to rewrite state.json. */
const STATE_SAVE_INTERVAL_MS = 60_000;

export class Monitor extends EventEmitter {
  private readonly providers: ProviderAdapter[];
  private readonly now: () => number;
  private config: AlarmConfig;

  readonly ledger = new UsageLedger();
  private readonly fits = new Map<string, ExchangeRateFit>(); // per binding-capable backend window
  private assessor = new WindowAssessor();
  private readonly fireLog: FireLog = emptyFireLog();
  readonly router: SinkRouter;

  private epsilonEwma: number | null = null;
  private epsilonAt: number | null = null;
  private lastTierByBackend = new Map<string, string | null>();
  private lastState: AppState | null = null;

  private readonly store: Store | null;
  private restored = false;
  private lastStateSaveAt = 0;
  private lastHistoryAt = new Map<string, { at: number; u: number }>();
  /** Utilization samples for the current windows, newest last. */
  private history: HistorySample[] = [];
  /** Alarm log, oldest first. The notifications view reverses it. */
  private alarmHistory: Alarm[] = [];

  constructor(opts: MonitorOptions) {
    super();
    this.providers = opts.providers;
    this.now = opts.now ?? Date.now;
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.router = new SinkRouter(this.config.routing);
    this.store = opts.store === undefined ? new Store() : opts.store;
  }

  /**
   * Load durable state. Safe to call more than once; only the first call
   * does work. Called automatically by the first tick().
   */
  async restore(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    if (!this.store) return;
    const now = this.now();

    const events = await this.store.loadLedger(now);
    if (events.length > 0) this.ledger.add(events);

    const state = await this.store.loadState();
    if (state) {
      for (const p of this.providers) {
        const offsets = state.tailOffsets[p.id];
        if (offsets) p.setTailOffsets(offsets);
        // Suppress replay of events we already hold.
        (p as ProviderAdapter & { seedSeen?: (ids: Iterable<string>) => void }).seedSeen?.(
          this.ledger.requestIds(),
        );
      }
      for (const [key, raw] of Object.entries(state.fits)) {
        this.fits.set(key, ExchangeRateFit.fromJSON(raw));
      }
      if (state.assessor) this.assessorRestore(state.assessor);
      if (state.fireLog) Object.assign(this.fireLog, state.fireLog);
      if (state.epsilon) {
        this.epsilonEwma = state.epsilon.value;
        this.epsilonAt = state.epsilon.at;
      }
      for (const [k, v] of Object.entries(state.tiers)) this.lastTierByBackend.set(k, v);
    }

    this.history = await this.store.loadHistory(now);
    for (const s of this.history) {
      const prev = this.lastHistoryAt.get(s.w);
      if (!prev || s.t > prev.at) this.lastHistoryAt.set(s.w, { at: s.t, u: s.u });
    }
    this.alarmHistory = await this.store.loadAlarms(now);
  }

  /** Utilization samples for one window key, oldest first. */
  historyFor(windowKey: string, sinceMs?: number): HistorySample[] {
    const cutoff = sinceMs ?? 0;
    return this.history.filter((s) => s.w === windowKey && s.t >= cutoff);
  }

  /** The alarm log, newest first — what the notifications view renders. */
  alarms(): Alarm[] {
    return [...this.alarmHistory].reverse();
  }

  async clearAlarmHistory(): Promise<void> {
    this.alarmHistory = [];
    await this.store?.clearAlarms();
  }

  setConfig(config: AlarmConfig): void {
    this.config = config;
    this.router.setRouting(config.routing);
  }

  get state(): AppState | null {
    return this.lastState;
  }

  async tick(): Promise<AppState> {
    await this.restore();
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
      this.alarmHistory.push(...alarms);
      await this.store?.appendAlarms(alarms);
      await this.router.route(alarms);
      for (const a of alarms) this.emit('alarm', a);
    }

    await this.recordHistory(windows, now);
    await this.maybeSaveState(now);

    this.emit('state', state);
    return state;
  }

  /** Downsampled: only on change, or every HISTORY_MIN_INTERVAL_MS. */
  private async recordHistory(windows: QuotaWindow[], now: number): Promise<void> {
    const fresh: HistorySample[] = [];
    for (const w of windows) {
      const key = `${w.backend}:${w.key}`;
      const prev = this.lastHistoryAt.get(key);
      const changed = !prev || prev.u !== w.utilization;
      const stale = !prev || now - prev.at >= HISTORY_MIN_INTERVAL_MS;
      if (!changed && !stale) continue;
      const sample: HistorySample = { t: w.observedAt, w: key, u: w.utilization };
      fresh.push(sample);
      this.history.push(sample);
      this.lastHistoryAt.set(key, { at: now, u: w.utilization });
    }
    if (fresh.length > 0) await this.store?.appendHistory(fresh);
  }

  private async maybeSaveState(now: number): Promise<void> {
    if (!this.store || now - this.lastStateSaveAt < STATE_SAVE_INTERVAL_MS) return;
    this.lastStateSaveAt = now;
    const tailOffsets: Record<string, Record<string, number>> = {};
    for (const p of this.providers) tailOffsets[p.id] = p.getTailOffsets();
    const fits: Record<string, unknown> = {};
    for (const [k, f] of this.fits) fits[k] = f.toJSON();
    await this.store.saveState({
      version: STORE_VERSION,
      savedAt: now,
      tailOffsets,
      fits,
      assessor: this.assessor.toJSON(),
      fireLog: this.fireLog,
      epsilon: this.epsilonEwma !== null && this.epsilonAt !== null
        ? { value: this.epsilonEwma, at: this.epsilonAt }
        : null,
      tiers: Object.fromEntries(this.lastTierByBackend),
    });
    await this.store.saveLedger(this.ledger.all(), now);
  }

  /** Replace the assessor with a restored one (its state is private). */
  private assessorRestore(raw: unknown): void {
    this.assessor = WindowAssessor.fromJSON(raw);
  }

  /** Flush everything now — call on shutdown. */
  async flush(): Promise<void> {
    this.lastStateSaveAt = 0;
    await this.maybeSaveState(this.now());
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
