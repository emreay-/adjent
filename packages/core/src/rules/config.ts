/**
 * Declarative alarm config, hot-reloadable from ~/.adjent/alarms.yaml
 * (docs/ALARMS.md). YAML via the pure-JS `yaml` package (no native modules).
 * Defaults below are the documented defaults; a broken config file degrades
 * to them rather than disabling alarms.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BackendId, Rule, Severity } from '../model/types.js';

export interface Routing {
  info: string[];
  warn: string[];
  critical: string[];
}

export interface AlarmConfig {
  rules: Rule[];
  routing: Routing;
}

export const DEFAULT_CONFIG: AlarmConfig = {
  rules: [
    {
      id: 'pace-any',
      type: 'pace',
      backend: 'any',
      window: 'any',
      tolerancePp: 10,
      exhaustionLeadMin: 45,
      cooldownMin: 20,
      severity: 'warn',
    },
    {
      id: 'steps',
      type: 'threshold',
      backend: 'any',
      window: 'any',
      levels: [25, 50, 80, 95],
      severity: { 25: 'info', 50: 'info', 80: 'warn', 95: 'critical' },
    },
    {
      id: 'runaway-agent',
      type: 'agent_burn',
      windowMin: 10,
      relToMedian: 4.0,
      sharePct: 60,
      absPctPerHour: 8.0,
      cooldownMin: 15,
      severity: 'warn',
    },
  ],
  routing: {
    info: ['tray'],
    warn: ['tray', 'toast'],
    critical: ['tray', 'toast', 'webhook'],
  },
};

export const configPath = (): string => path.join(os.homedir(), '.adjent', 'alarms.yaml');

export async function loadConfig(file: string = configPath()): Promise<AlarmConfig> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch {
    return DEFAULT_CONFIG;
  }
  try {
    const doc = parseYaml(text) as { alarms?: unknown[]; routing?: Record<string, unknown> } | null;
    if (!doc || typeof doc !== 'object') return DEFAULT_CONFIG;
    const rules = Array.isArray(doc.alarms) ? doc.alarms.map(coerceRule).filter((r): r is Rule => r !== null) : [];
    return {
      rules: rules.length > 0 ? rules : DEFAULT_CONFIG.rules,
      routing: coerceRouting(doc.routing),
    };
  } catch {
    return DEFAULT_CONFIG; // broken YAML degrades to defaults, never to silence
  }
}

// --------------------------------------------------------------------------
const SEVERITIES: readonly Severity[] = ['info', 'warn', 'critical'];
const sev = (v: unknown, fallback: Severity): Severity =>
  SEVERITIES.includes(v as Severity) ? (v as Severity) : fallback;
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const backendOf = (v: unknown): BackendId | 'any' => (v === 'claude' || v === 'codex' ? v : 'any');
/** '20m' | '1h' | 45 → minutes */
const minutes = (v: unknown, fallback: number): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)?$/.exec(v.trim());
    if (m) {
      const n = Number(m[1]);
      return m[2] === 'h' ? n * 60 : m[2] === 'd' ? n * 1440 : n;
    }
  }
  return fallback;
};

function coerceRule(raw: unknown): Rule | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'] : null;
  if (!id) return null;
  const scope = (r['scope'] ?? {}) as Record<string, unknown>;

  switch (r['type']) {
    case 'pace':
      return {
        id,
        type: 'pace',
        backend: backendOf(scope['backend'] ?? r['backend']),
        window: typeof (scope['window'] ?? r['window']) === 'string' ? ((scope['window'] ?? r['window']) as string) : 'any',
        tolerancePp: num(r['tolerance_pp'], 10),
        exhaustionLeadMin: minutes(r['project_exhaustion_lead'], 45),
        cooldownMin: minutes(r['cooldown'], 20),
        severity: sev(r['severity'], 'warn'),
      };
    case 'threshold': {
      const levels = Array.isArray(r['levels']) ? r['levels'].filter((l): l is number => typeof l === 'number') : [];
      const sevMap: Partial<Record<number, Severity>> = {};
      if (typeof r['severity'] === 'object' && r['severity'] !== null) {
        for (const [k, v] of Object.entries(r['severity'] as Record<string, unknown>)) {
          const lvl = Number(k);
          if (Number.isFinite(lvl)) sevMap[lvl] = sev(v, 'info');
        }
      }
      return {
        id,
        type: 'threshold',
        backend: backendOf(scope['backend'] ?? r['backend']),
        window: typeof (scope['window'] ?? r['window']) === 'string' ? ((scope['window'] ?? r['window']) as string) : 'any',
        levels: levels.length > 0 ? levels : [25, 50, 80, 95],
        severity: sevMap,
      };
    }
    case 'agent_burn': {
      const trig = (r['trigger'] ?? {}) as Record<string, unknown>;
      return {
        id,
        type: 'agent_burn',
        windowMin: minutes(r['window'], 10),
        relToMedian: num(trig['rel_to_median'], 4),
        sharePct: num(trig['share_pct'], 60),
        absPctPerHour: num(trig['abs_pct_per_hour'], 8),
        cooldownMin: minutes(r['cooldown'], 15),
        severity: sev(r['severity'], 'warn'),
      };
    }
    default:
      return null;
  }
}

function coerceRouting(raw: Record<string, unknown> | undefined): Routing {
  const list = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : fallback;
  return {
    info: list(raw?.['info'], DEFAULT_CONFIG.routing.info),
    warn: list(raw?.['warn'], DEFAULT_CONFIG.routing.warn),
    critical: list(raw?.['critical'], DEFAULT_CONFIG.routing.critical),
  };
}
