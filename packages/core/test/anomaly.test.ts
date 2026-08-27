/**
 * The `anomaly` rule: "looks like a loop".
 *
 * The improvement plan specifies this rule as four synthetic timelines, and
 * they are the spec — a healthy growing session stays silent, a fixed-point
 * loop fires, a bursty session stays silent, and a loop that stops does not
 * re-fire after its cooldown. Everything else here supports those four.
 *
 * The rule works from turn *shape*, never from message content (hard rule 2),
 * which is what it can and cannot see: a worker re-sending nearly the same
 * request is visible; a semantic loop whose turns vary in size is not, and
 * docs/ALARMS.md says so rather than implying omniscience.
 *
 * Fixtures are synthetic (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { agentShapes } from '../src/quota/shape.js';
import { evaluate } from '../src/rules/evaluate.js';
import { emptyFireLog } from '../src/model/types.js';
import type { AnomalyRule, AppState, UsageEvent } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const AGENT = 'claude:session-1';

const RULE: AnomalyRule = {
  id: 'looping-subagent',
  type: 'anomaly',
  windowMin: 15,
  minTurns: 12,
  shapeCv: 0.15,
  growthFloor: 0.2,
  absPctPerHour: 2.0,
  cooldownMin: 30,
  severity: 'warn',
};

const ev = (i: number, total: number, cacheRead: number, subId: string | null = null): UsageEvent => ({
  ts: T0 + i * MIN,
  backend: 'claude',
  agentId: AGENT,
  subId,
  model: 'model-x',
  effort: null,
  // `total` is split so the sum is what the shape metric sees.
  tokens: { input: total - cacheRead, cacheWrite: 0, cacheRead, output: 0, thinking: 0 },
  requests: 1,
  requestId: `req-${i}-${subId ?? 'main'}`,
});

/** State carrying the shapes for `events`, and enough burn to clear the floor. */
const stateOf = (events: UsageEvent[], pctPerHour = 4.1): AppState =>
  ({
    generatedAt: T0,
    backends: [],
    agents: [
      {
        id: AGENT,
        backend: 'claude',
        label: 'demo',
        projectPath: '/synthetic/project',
        gitBranch: null,
        model: 'model-x',
        effort: null,
        entrypoint: null,
        parentId: null,
        pid: null,
        state: 'live',
        startedAt: T0,
        lastActivityAt: T0,
        totals: { input: 1_000, cacheWrite: 0, cacheRead: 8_000, output: 500, thinking: 0 },
      },
    ],
    limits: [],
    agentBurns: [{ agentId: AGENT, pctPerHour, confidence: 'high' }],
    agentShapes: agentShapes(events),
    epsilon: null,
    fitConfidence: 'high',
  }) as unknown as AppState;

const fire = (events: UsageEvent[], opts: { burn?: number; memory?: ReturnType<typeof emptyFireLog>; now?: number } = {}) =>
  evaluate(stateOf(events, opts.burn ?? 4.1), [RULE], opts.memory ?? emptyFireLog(), opts.now ?? T0 + 15 * MIN);

// ---------------------------------------------------------------------------
// The four timelines the plan specifies.
// ---------------------------------------------------------------------------
describe('the specified timelines', () => {
  it('a healthy growing session — silent', () => {
    // Varied turn sizes, and context accumulating turn over turn.
    const events = Array.from({ length: 14 }, (_, i) =>
      ev(i, 5_000 + i * 900 + (i % 3) * 2_000, 1_000 + i * 800),
    );
    expect(fire(events)).toHaveLength(0);
  });

  it('a fixed-point loop — fires within the window', () => {
    // Every turn the same size, context flat: the same request, over and over.
    const events = Array.from({ length: 14 }, (_, i) => ev(i, 20_000, 8_000));
    const alarms = fire(events);

    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.ruleId).toBe('looping-subagent');
    expect(alarms[0]!.title).toContain('Looks like a loop');
    expect(alarms[0]!.agentId).toBe(AGENT);
  });

  it('a bursty session with varied turn sizes — silent', () => {
    // Enough turns, flat context, but the sizes are all over the place — which
    // is ordinary work, not a loop.
    const sizes = [2_000, 45_000, 6_000, 80_000, 3_000, 60_000, 9_000, 120_000, 4_000, 30_000, 7_000, 90_000, 5_000, 25_000];
    const events = sizes.map((t, i) => ev(i, t, 1_000));
    expect(fire(events)).toHaveLength(0);
  });

  it('a loop that stops — no re-fire after the cooldown', () => {
    const looping = Array.from({ length: 14 }, (_, i) => ev(i, 20_000, 8_000));
    const memory = emptyFireLog();

    expect(fire(looping, { memory })).toHaveLength(1);

    // It stopped: no turns in the window at all, well past the cooldown.
    expect(fire([], { memory, now: T0 + 60 * MIN })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('each condition is load-bearing', () => {
  const loop = Array.from({ length: 14 }, (_, i) => ev(i, 20_000, 8_000));

  it('too few turns is not yet a pattern', () => {
    expect(fire(loop.slice(0, 11))).toHaveLength(0);
  });

  it('a cheap loop stays off the screen', () => {
    // Same shape, but below the burn floor: not worth interrupting anyone.
    expect(fire(loop, { burn: 0.5 })).toHaveLength(0);
  });

  it('growing context clears it even when every turn is the same size', () => {
    // Uniform sizes happen in batch work; what distinguishes a loop is that
    // the context stops growing too.
    const uniformButGrowing = Array.from({ length: 14 }, (_, i) => ev(i, 20_000, 1_000 + i * 500));
    expect(fire(uniformButGrowing)).toHaveLength(0);
  });

  it('does not re-fire while still inside the cooldown', () => {
    const memory = emptyFireLog();
    expect(fire(loop, { memory })).toHaveLength(1);
    expect(fire(loop, { memory, now: T0 + 20 * MIN })).toHaveLength(0);
    // ...and fires again once the cooldown has elapsed and it is still looping.
    expect(fire(loop, { memory, now: T0 + 50 * MIN })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('subagents are the case this exists for', () => {
  it('finds a looping subagent whose parent is working normally', () => {
    // Merged, these look like neither: the parent's variety inflates cv and
    // the subagent's repetition is lost. Partitioned, the loop is obvious.
    const parent = Array.from({ length: 14 }, (_, i) => ev(i, 5_000 + i * 3_000, 1_000 + i * 900));
    const sub = Array.from({ length: 14 }, (_, i) => ev(100 + i, 20_000, 8_000, 'agent-alpha'));

    const alarms = fire([...parent, ...sub]);

    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.body).toContain('a subagent of');
    // The agent is still the session: a subagent never becomes an agent id.
    expect(alarms[0]!.agentId).toBe(AGENT);
  });

  it('two looping subagents are two alarms, not one silencing the other', () => {
    const a = Array.from({ length: 14 }, (_, i) => ev(100 + i, 20_000, 8_000, 'agent-alpha'));
    const b = Array.from({ length: 14 }, (_, i) => ev(200 + i, 30_000, 9_000, 'agent-beta'));
    expect(fire([...a, ...b])).toHaveLength(2);
  });

  it('describes the session by name and never the subagent as a thing of its own', () => {
    const sub = Array.from({ length: 14 }, (_, i) => ev(i, 20_000, 8_000, 'agent-alpha'));
    const body = fire(sub)[0]!.body;
    // The label a user knows is the session's; the subagent's internal id is
    // a detection label and must not surface (GLOSSARY).
    expect(body).not.toContain('agent-alpha');
    expect(fire(sub)[0]!.title).toContain('demo');
  });
});

// ---------------------------------------------------------------------------
describe('shape metrics', () => {
  it('reports uniform turns as near-zero variation and flat growth', () => {
    const [s] = agentShapes(Array.from({ length: 5 }, (_, i) => ev(i, 20_000, 8_000)));
    expect(s!.turns).toBe(5);
    expect(s!.cv).toBeCloseTo(0, 5);
    expect(s!.growth).toBe(0);
  });

  it('reports a growing session as growth 1', () => {
    const [s] = agentShapes(Array.from({ length: 5 }, (_, i) => ev(i, 10_000, 1_000 + i * 500)));
    expect(s!.growth).toBe(1);
  });

  it('a single turn cannot look like a loop', () => {
    // No pairs to compare: growth defaults to 1 (growing) so the rule stays
    // silent rather than firing on no evidence.
    const [s] = agentShapes([ev(0, 20_000, 8_000)]);
    expect(s!.growth).toBe(1);
  });
});
