/** Durable state: round-trips, retention, and corruption tolerance. Synthetic. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { RETENTION, STORE_VERSION, Store } from '../src/persist.js';
import { ExchangeRateFit } from '../src/quota/fit.js';
import { UsageLedger } from '../src/quota/ledger.js';
import { LimitAssessor } from '../src/quota/assess.js';
import { emptyFireLog, type Alarm, type QuotaLimit, type UsageEvent } from '../src/model/types.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'adjent-p-'));
  store = new Store(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ev = (ts: number, id: string): UsageEvent => ({
  ts, backend: 'claude', agentId: 'claude:a', model: 'model-x', effort: null,
  tokens: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4, thinking: 0 },
  requests: 1, requestId: id,
});

const alarm = (firedAt: number, id: string): Alarm => ({
  id, ruleId: 'r', severity: 'warn', title: `t-${id}`, body: 'b',
  firedAt, backend: 'claude', limitKey: '5h', agentId: null,
});

const qw = (u: number, at: number): QuotaLimit => ({
  backend: 'claude', key: '5h', label: 'Claude · 5h', windowMinutes: 300,
  utilization: u, resetsAt: T0 + 300 * MIN, severity: null, vendorActive: false,
  scope: null, source: 'reported', observedAt: at,
});

describe('Store', () => {
  it('round-trips state and drops it on a version mismatch', async () => {
    await store.saveState({
      version: STORE_VERSION, savedAt: T0,
      tailOffsets: { claude: { '/x.jsonl': 42 } },
      fits: {}, assessor: null, fireLog: emptyFireLog(), epsilon: { value: 1.5, at: T0 },
      tiers: { claude: 'demo-tier' },
    });
    const back = await store.loadState();
    expect(back?.tailOffsets['claude']?.['/x.jsonl']).toBe(42);
    expect(back?.epsilon?.value).toBe(1.5);

    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 999 }));
    expect(await store.loadState()).toBeNull();
  });

  it('a corrupt file degrades to empty, never throws', async () => {
    writeFileSync(path.join(dir, 'state.json'), '{not json');
    writeFileSync(path.join(dir, 'alarms.jsonl'), 'garbage\n{"firedAt":1,"title":"x"}\n');
    expect(await store.loadState()).toBeNull();
    // the torn line is skipped, the valid one survives
    expect(await store.loadAlarms(2)).toHaveLength(1);
  });

  it('prunes the ledger and alarms past their retention', async () => {
    const old = T0 - RETENTION.ledgerMs - MIN;
    await store.saveLedger([ev(old, 'old'), ev(T0, 'new')], T0);
    const back = await store.loadLedger(T0);
    expect(back.map((e) => e.requestId)).toEqual(['new']);

    await store.appendAlarms([alarm(T0 - RETENTION.alarmsMs - MIN, 'a-old'), alarm(T0, 'a-new')]);
    expect((await store.loadAlarms(T0)).map((a) => a.id)).toEqual(['a-new']);
  });

  it('history appends and compacts', async () => {
    await store.appendHistory([{ t: T0 - RETENTION.historyMs - MIN, w: 'claude:5h', u: 10 }]);
    await store.appendHistory([{ t: T0, w: 'claude:5h', u: 20 }]);
    expect(await store.loadHistory(T0)).toHaveLength(1);
    await store.compactHistory(T0);
    expect(await store.loadHistory(T0)).toHaveLength(1);
  });
});

describe('restart survival', () => {
  it('a restored fit keeps its bootstrap and prices agents immediately', async () => {
    const ledger = new UsageLedger();
    const fit = new ExchangeRateFit();
    let u = 0;
    fit.observePoll(qw(0, T0), ledger);
    for (let m = 5; m <= 60; m += 5) {
      const ts = T0 + m * MIN;
      ledger.add([ev(ts - MIN, `r${m}`)]);
      u += 0.5;
      fit.observePoll(qw(u, ts), ledger);
    }
    expect(fit.bootstrapped).toBe(true);
    const before = fit.fit();

    // Serialize → deserialize, as a restart would.
    const revived = ExchangeRateFit.fromJSON(JSON.parse(JSON.stringify(fit.toJSON())));
    expect(revived.bootstrapped).toBe(true);
    const after = revived.fit();
    expect(after?.sampleCount).toBe(before?.sampleCount);
    expect(after?.level).toBe(before?.level);
  });

  it('a restored assessor keeps its burn rate and binding choice', () => {
    const a = new LimitAssessor();
    for (let m = 0; m <= 60; m += 5) a.assess([qw((20 / 60) * m, T0 + m * MIN)], T0 + m * MIN);
    const burnBefore = a.assess([qw(20, T0 + 60 * MIN)], T0 + 60 * MIN)[0]!.burn;

    const revived = LimitAssessor.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
    const after = revived.assess([qw(21, T0 + 65 * MIN)], T0 + 65 * MIN)[0]!;
    expect(after.burn).not.toBeNull();
    expect(after.binding).toBe(true);
    // Continuity: the smoothed rate did not restart from zero.
    expect(Math.abs((after.burn!.pctPerHour) - (burnBefore!.pctPerHour))).toBeLessThan(15);
  });
});
