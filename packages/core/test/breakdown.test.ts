/**
 * The exact token split behind one limit (docs/UI.md tier 3).
 *
 * The properties that matter are the boundaries: a breakdown that quietly
 * counts another backend's tokens, or events from before the window opened,
 * would read as authoritative while being wrong — and it is labelled `exact`,
 * which is the strongest provenance the app has.
 */
import { describe, expect, it } from 'vitest';
import { UsageLedger } from '../src/quota/ledger.js';
import { limitBreakdown, limitWindow } from '../src/quota/breakdown.js';
import type { BackendId, QuotaLimit, UsageEvent } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const H = 3600_000;

let seq = 0;
function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  seq += 1;
  return {
    ts: T0,
    backend: 'claude',
    agentId: 'claude:s1',
    model: 'model-a',
    effort: null,
    tokens: { input: 100, cacheWrite: 10, cacheRead: 1000, output: 50, thinking: 0 },
    requests: 1,
    requestId: `req-${seq}`,
    ...over,
  };
}

function limit(over: Partial<QuotaLimit> = {}): QuotaLimit {
  return {
    backend: 'claude' as BackendId,
    key: '5h',
    label: 'Claude · 5h',
    windowMinutes: 300,
    utilization: 40,
    resetsAt: T0 + 2 * H,
    severity: null,
    vendorActive: false,
    scope: null,
    source: 'reported',
    observedAt: T0,
    ...over,
  };
}

const ledgerOf = (events: UsageEvent[]): UsageLedger => {
  const l = new UsageLedger();
  l.add(events);
  return l;
};

describe('limitWindow', () => {
  it('anchors to the reset when the vendor reports one', () => {
    const w = limitWindow(limit(), T0 + H);
    // 5h window ending at a reset 2h out: it opened 3h before now.
    expect(w.from).toBe(T0 + 2 * H - 5 * H);
    expect(w.to).toBe(T0 + H);
  });

  it('falls back to a trailing window when the reset is unknown', () => {
    const w = limitWindow(limit({ resetsAt: null }), T0);
    expect(w.from).toBe(T0 - 5 * H);
    expect(w.to).toBe(T0);
  });

  it('never starts after now, even if the vendor reset is stale', () => {
    const w = limitWindow(limit({ resetsAt: T0 + 100 * H }), T0);
    expect(w.from).toBeLessThanOrEqual(T0);
  });
});

describe('limitBreakdown', () => {
  it('groups by model and kind, most tokens first', () => {
    const l = ledgerOf([
      ev({ model: 'model-a' }),
      ev({ model: 'model-a' }),
      ev({ model: 'model-b', tokens: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1, thinking: 0 } }),
    ]);
    const b = limitBreakdown(l, limit(), T0 + H);

    expect(b.rows.map((r) => r.model)).toEqual(['model-a', 'model-b']);
    expect(b.rows[0]!.tokens).toEqual({ input: 200, cacheWrite: 20, cacheRead: 2000, output: 100 });
    expect(b.rows[0]!.total).toBe(2320);
    expect(b.rows[0]!.requests).toBe(2);
    expect(b.total).toBe(2322);
    expect(b.totals.cacheRead).toBe(2000);
    expect(b.requests).toBe(3);
    expect(b.events).toBe(3);
  });

  it('is exact, never derived — it counts, it does not model', () => {
    expect(limitBreakdown(ledgerOf([ev()]), limit(), T0 + H).source).toBe('exact');
  });

  it('excludes events from before the window opened', () => {
    const l = ledgerOf([ev({ ts: T0 - 4 * H }), ev({ ts: T0 })]);
    // Window opened at T0 - 3h, so the older event is outside it.
    const b = limitBreakdown(l, limit(), T0 + H);
    expect(b.events).toBe(1);
  });

  it('counts only the limit’s own backend', () => {
    const l = ledgerOf([ev(), ev({ backend: 'codex', agentId: 'codex:s1', model: 'model-c' })]);
    const b = limitBreakdown(l, limit(), T0 + H);
    expect(b.events).toBe(1);
    expect(b.rows.map((r) => r.model)).toEqual(['model-a']);
  });

  it('honours a scoped limit by matching the model name', () => {
    const l = ledgerOf([ev({ model: 'model-a' }), ev({ model: 'special-1' })]);
    const b = limitBreakdown(l, limit({ key: '7d:scoped', scope: 'Special' }), T0 + H);
    expect(b.scope).toBe('Special');
    expect(b.rows.map((r) => r.model)).toEqual(['special-1']);
    expect(b.events).toBe(1);
  });

  it('reports an empty window rather than throwing', () => {
    const b = limitBreakdown(new UsageLedger(), limit(), T0 + H);
    expect(b.events).toBe(0);
    expect(b.rows).toEqual([]);
    expect(b.total).toBe(0);
    expect(b.limitKey).toBe('claude:5h');
  });
});

describe('limitBreakdown agent attribution', () => {
  it('says who spent each model’s share, most first', () => {
    const l = ledgerOf([
      ev({ agentId: 'claude:a', model: 'model-a' }),
      ev({ agentId: 'claude:b', model: 'model-a' }),
      ev({ agentId: 'claude:b', model: 'model-a' }),
      ev({ agentId: 'claude:c', model: 'model-b' }),
    ]);
    const b = limitBreakdown(l, limit(), T0 + H);

    const rowA = b.rows.find((r) => r.model === 'model-a')!;
    expect(rowA.agents.map((a) => a.agentId)).toEqual(['claude:b', 'claude:a']);
    // Agent totals must sum back to the model total, or the shares mislead.
    expect(rowA.agents.reduce((n, a) => n + a.total, 0)).toBe(rowA.total);
    expect(rowA.agents.reduce((n, a) => n + a.requests, 0)).toBe(rowA.requests);
    expect(rowA.agents[0]!.requests).toBe(2);

    const rowB = b.rows.find((r) => r.model === 'model-b')!;
    expect(rowB.agents).toHaveLength(1);
    expect(rowB.agents[0]!.agentId).toBe('claude:c');
  });

  it('keeps attribution inside the window and the backend', () => {
    const l = ledgerOf([
      ev({ agentId: 'claude:a', ts: T0 - 4 * H }),
      ev({ agentId: 'codex:z', backend: 'codex' }),
      ev({ agentId: 'claude:b' }),
    ]);
    const b = limitBreakdown(l, limit(), T0 + H);
    const ids = b.rows.flatMap((r) => r.agents.map((a) => a.agentId));
    expect(ids).toEqual(['claude:b']);
  });
});
