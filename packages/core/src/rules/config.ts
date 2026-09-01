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
import type { BackendId, Rule, RuleAction, Severity } from '../model/types.js';
// Value import, but no runtime cycle: sinks/sink.ts imports only `type Routing`
// from here, and type-only imports are erased.
import { KNOWN_SINK_IDS } from '../sinks/sink.js';

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
      limit: 'any',
      tolerancePp: 10,
      exhaustionLeadMin: 45,
      cooldownMin: 20,
      severity: 'warn',
    },
    {
      id: 'steps',
      type: 'threshold',
      backend: 'any',
      limit: 'any',
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
    // `webhook` is deliberately absent: it cannot be built without
    // settings.alarmWebhookUrl, so shipping it here routed every user's
    // critical alarms into a sink nothing had registered. Opt in by setting the
    // URL and adding `webhook` to this list.
    critical: ['tray', 'toast'],
  },
};

export const configPath = (): string => path.join(os.homedir(), '.adjent', 'alarms.yaml');

/**
 * Write the config file the way an editor would — atomically.
 *
 * The file is watched, and the watcher reacts to a write in progress as readily
 * as to a finished one. A direct write is briefly a truncated document, which
 * would be read, reported as broken, and complained about in a toast that
 * describes a state that no longer exists by the time it appears. Writing a
 * temporary file and renaming it means the watcher only ever sees whole files.
 *
 * This is Adjent's own directory. Nothing here goes near a vendor's.
 */
export async function saveConfigText(text: string, file: string = configPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, 'utf-8');
  await fs.rename(tmp, file);
}

export async function loadConfig(file: string = configPath()): Promise<AlarmConfig> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf-8');
  } catch {
    return DEFAULT_CONFIG;
  }
  try {
    const doc: unknown = parseYaml(text);
    if (!doc || typeof doc !== 'object') return DEFAULT_CONFIG;
    return buildConfig(doc as { alarms?: unknown; routing?: unknown });
  } catch {
    return DEFAULT_CONFIG; // broken YAML degrades to defaults, never to silence
  }
}

/**
 * Document → config. The single place coercion happens, so `loadConfig` and
 * `parseConfig` can never understand a file differently.
 */
function buildConfig(doc: { alarms?: unknown; routing?: unknown }): AlarmConfig {
  const rules = Array.isArray(doc.alarms)
    ? doc.alarms.map(coerceRule).filter((r): r is Rule => r !== null)
    : [];
  return {
    rules: rules.length > 0 ? rules : DEFAULT_CONFIG.rules,
    routing: coerceRouting(doc.routing as Record<string, unknown> | undefined),
  };
}

// --------------------------------------------------------------------------
const SEVERITIES: readonly Severity[] = ['info', 'warn', 'critical'];
const sev = (v: unknown, fallback: Severity): Severity =>
  SEVERITIES.includes(v as Severity) ? (v as Severity) : fallback;
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** `limit:` is the current key; `window:` is still accepted from older files. */
const limitOf = (scope: Record<string, unknown>, r: Record<string, unknown>): string | 'any' => {
  const v = scope['limit'] ?? r['limit'] ?? scope['window'] ?? r['window'];
  return typeof v === 'string' ? v : 'any';
};
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

/**
 * `actions:` — what a rule does besides telling you.
 *
 * Only `hold` exists, and it sets the advisory gate. Unknown entries are
 * dropped (and reported as a diagnostic), never guessed at: a rule that
 * quietly ignored an action a user asked for would be worse than one that
 * refuses it loudly, and one that invented an action would be far worse.
 */
const KNOWN_ACTIONS: readonly string[] = ['hold'];
function coerceActions(raw: unknown): RuleAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is RuleAction => typeof a === 'string' && KNOWN_ACTIONS.includes(a));
}

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
        limit: limitOf(scope, r),
        tolerancePp: num(r['tolerance_pp'], 10),
        exhaustionLeadMin: minutes(r['project_exhaustion_lead'], 45),
        cooldownMin: minutes(r['cooldown'], 20),
        severity: sev(r['severity'], 'warn'),
        actions: coerceActions(r['actions']),
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
        limit: limitOf(scope, r),
        levels: levels.length > 0 ? levels : [25, 50, 80, 95],
        severity: sevMap,
        actions: coerceActions(r['actions']),
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
        actions: coerceActions(r['actions']),
      };
    }
    case 'anomaly': {
      const trig = (r['trigger'] ?? {}) as Record<string, unknown>;
      return {
        id,
        type: 'anomaly',
        windowMin: minutes(r['window'], 15),
        minTurns: num(trig['min_turns'], 12),
        shapeCv: num(trig['shape_cv'], 0.15),
        growthFloor: num(trig['growth_floor'], 0.2),
        absPctPerHour: num(trig['abs_pct_per_hour'], 2.0),
        cooldownMin: minutes(r['cooldown'], 30),
        severity: sev(r['severity'], 'warn'),
        actions: coerceActions(r['actions']),
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

// ---------------------------------------------------------------------------
// Diagnostics
//
// Loading and *judging* a config are different jobs. `loadConfig` must stay
// lenient — a broken file degrades to defaults, never to silence, because an
// alarm engine that quietly stops alarming is the worst possible failure. But
// leniency with no way to ask "what did you actually understand?" means a typo
// costs you a rule and says nothing.
//
// So the coercion below is untouched, and this is a separate inspection pass
// over the same document. It changes no behaviour; it only reports. Typo
// detection is most of the value: `tolerence_pp` is a silently ignored key
// today, and that is exactly the mistake a person makes at 2am.
// ---------------------------------------------------------------------------

export interface Diagnostic {
  level: 'error' | 'warn';
  /** Where, in the file's own terms: `alarms[2].tolerance_pp`. */
  path: string;
  message: string;
}

export interface ParsedConfig {
  config: AlarmConfig;
  diagnostics: Diagnostic[];
}

/** Keys each rule type understands. Anything else is almost certainly a typo. */
const COMMON_KEYS = ['id', 'type', 'scope', 'backend', 'limit', 'severity', 'cooldown', 'actions'];
const KNOWN_KEYS: Record<string, string[]> = {
  pace: [...COMMON_KEYS, 'tolerance_pp', 'project_exhaustion_lead', 'window'],
  threshold: [...COMMON_KEYS, 'levels', 'window'],
  // `window` here is a *time span*, not the deprecated scope key (GLOSSARY).
  agent_burn: ['id', 'type', 'severity', 'cooldown', 'window', 'trigger', 'actions'],
  anomaly: ['id', 'type', 'severity', 'cooldown', 'window', 'trigger', 'actions'],
};
const SCOPE_KEYS = ['backend', 'limit', 'window'];
/**
 * Per rule type, not one shared list: a flat list would make `anomaly`'s
 * trigger keys legal on `agent_burn` and vice versa, so a key in the wrong
 * rule would be accepted and then ignored — the exact failure diagnostics
 * exist to prevent.
 */
const TRIGGER_KEYS: Record<string, string[]> = {
  agent_burn: ['rel_to_median', 'share_pct', 'abs_pct_per_hour'],
  anomaly: ['min_turns', 'shape_cv', 'growth_floor', 'abs_pct_per_hour'],
};
const RULE_TYPES = Object.keys(KNOWN_KEYS);

const err = (path: string, message: string): Diagnostic => ({ level: 'error', path, message });
const warn = (path: string, message: string): Diagnostic => ({ level: 'warn', path, message });

/** Report a value that is present but not a finite number. */
function checkNumber(o: Record<string, unknown>, key: string, at: string, out: Diagnostic[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  out.push(err(`${at}.${key}`, `expected a number, got ${JSON.stringify(v)}`));
}

/** Report a duration that is neither a number nor `20m` / `1h` / `2d`. */
function checkDuration(o: Record<string, unknown>, key: string, at: string, out: Diagnostic[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (typeof v === 'string' && /^\d+(?:\.\d+)?\s*(m|h|d)?$/.test(v.trim())) return;
  out.push(err(`${at}.${key}`, `expected a duration like 20m, 1h or a number of minutes, got ${JSON.stringify(v)}`));
}

function checkUnknownKeys(o: Record<string, unknown>, known: string[], at: string, out: Diagnostic[]): void {
  for (const k of Object.keys(o)) {
    if (!known.includes(k)) {
      out.push(warn(`${at}.${k}`, `unknown key — ignored. Expected one of: ${known.join(', ')}`));
    }
  }
}

function validateRule(raw: unknown, at: string, seen: Set<string>, out: Diagnostic[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    out.push(err(at, 'expected a rule object'));
    return;
  }
  const r = raw as Record<string, unknown>;

  const id = r['id'];
  if (typeof id !== 'string' || id.length === 0) {
    out.push(err(`${at}.id`, 'every rule needs a string id — this rule is ignored'));
  } else if (seen.has(id)) {
    // Two rules with one id: the fire log keys on it, so the second silently
    // shares the first's cooldown state.
    out.push(err(`${at}.id`, `duplicate rule id ${JSON.stringify(id)}`));
  } else {
    seen.add(id);
  }

  const type = r['type'];
  if (typeof type !== 'string' || !RULE_TYPES.includes(type)) {
    out.push(
      err(`${at}.type`, `unknown rule type ${JSON.stringify(type)} — this rule is ignored. Expected one of: ${RULE_TYPES.join(', ')}`),
    );
    return; // Without a type there is nothing further to check against.
  }

  checkUnknownKeys(r, KNOWN_KEYS[type]!, at, out);

  const scope = r['scope'];
  if (scope !== undefined) {
    if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
      out.push(err(`${at}.scope`, 'expected a mapping'));
    } else {
      checkUnknownKeys(scope as Record<string, unknown>, SCOPE_KEYS, `${at}.scope`, out);
      if ('window' in (scope as Record<string, unknown>)) {
        out.push(
          warn(`${at}.scope.window`, 'deprecated — use `limit:`. A window is a UI element; `limit` is the vendors\' own word'),
        );
      }
    }
  }
  // `window` is a *time span* for the per-worker rules and the deprecated
  // spelling of `limit:` for the limit-scoped ones (GLOSSARY: a window is a UI
  // element; `limit` is the vendors' own word).
  if (type !== 'agent_burn' && type !== 'anomaly' && 'window' in r) {
    out.push(warn(`${at}.window`, 'deprecated — use `limit:`'));
  }

  if (r['actions'] !== undefined) {
    if (!Array.isArray(r['actions'])) {
      out.push(err(`${at}.actions`, 'expected a list of action names'));
    } else {
      for (const a of r['actions']) {
        if (typeof a !== 'string' || !KNOWN_ACTIONS.includes(a)) {
          out.push(
            warn(
              `${at}.actions`,
              `unknown action ${JSON.stringify(a)} — ignored. Known actions: ${KNOWN_ACTIONS.join(', ')}`,
            ),
          );
        }
      }
    }
  }

  checkDuration(r, 'cooldown', at, out);

  if (type === 'pace') {
    checkNumber(r, 'tolerance_pp', at, out);
    checkDuration(r, 'project_exhaustion_lead', at, out);
  }

  if (type === 'threshold') {
    const levels = r['levels'];
    if (levels !== undefined) {
      if (!Array.isArray(levels)) {
        out.push(err(`${at}.levels`, 'expected a list of percentages'));
      } else {
        const nums = levels.filter((l): l is number => typeof l === 'number' && Number.isFinite(l));
        if (nums.length !== levels.length) {
          out.push(err(`${at}.levels`, 'every level must be a number'));
        }
        if (nums.length === 0) {
          out.push(warn(`${at}.levels`, 'empty — the default levels are used instead'));
        }
        // Levels are announced in order as utilization climbs, so an unsorted
        // list reads as a bug in Adjent rather than in the file.
        const sorted = [...nums].sort((a, b) => a - b);
        if (nums.some((n, i) => n !== sorted[i])) {
          out.push(warn(`${at}.levels`, `not in ascending order — expected ${JSON.stringify(sorted)}`));
        }
      }
    }
  }

  if (type === 'agent_burn' || type === 'anomaly') {
    checkDuration(r, 'window', at, out);
    const keys = TRIGGER_KEYS[type] as string[];
    const trig = r['trigger'];
    if (trig !== undefined) {
      if (typeof trig !== 'object' || trig === null || Array.isArray(trig)) {
        out.push(err(`${at}.trigger`, 'expected a mapping'));
      } else {
        const t = trig as Record<string, unknown>;
        checkUnknownKeys(t, keys, `${at}.trigger`, out);
        for (const k of keys) checkNumber(t, k, `${at}.trigger`, out);
      }
    }
  }
}

/**
 * Parse and judge in one pass. The config is built by exactly the same
 * coercion `loadConfig` uses, so the diagnostics can never disagree with what
 * actually runs.
 */
export function parseConfig(text: string): ParsedConfig {
  const diagnostics: Diagnostic[] = [];

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    diagnostics.push(err('$', `not valid YAML: ${e instanceof Error ? e.message : String(e)}`));
    return { config: DEFAULT_CONFIG, diagnostics };
  }

  if (doc === null || doc === undefined) {
    diagnostics.push(warn('$', 'empty file — the built-in defaults are used'));
    return { config: DEFAULT_CONFIG, diagnostics };
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    diagnostics.push(err('$', 'expected a mapping with `alarms:` and optionally `routing:`'));
    return { config: DEFAULT_CONFIG, diagnostics };
  }

  const d = doc as { alarms?: unknown; routing?: unknown };
  checkUnknownKeys(doc as Record<string, unknown>, ['alarms', 'routing'], '$', diagnostics);

  if (d.alarms === undefined) {
    diagnostics.push(warn('$.alarms', 'no rules defined — the built-in defaults are used'));
  } else if (!Array.isArray(d.alarms)) {
    diagnostics.push(err('$.alarms', 'expected a list of rules'));
  } else {
    const seen = new Set<string>();
    d.alarms.forEach((raw, i) => validateRule(raw, `alarms[${i}]`, seen, diagnostics));
  }

  if (d.routing !== undefined) {
    if (typeof d.routing !== 'object' || d.routing === null || Array.isArray(d.routing)) {
      diagnostics.push(err('$.routing', 'expected a mapping of severity to sink list'));
    } else {
      checkUnknownKeys(d.routing as Record<string, unknown>, ['info', 'warn', 'critical'], '$.routing', diagnostics);
      for (const [k, v] of Object.entries(d.routing as Record<string, unknown>)) {
        if (v !== undefined && !Array.isArray(v)) {
          diagnostics.push(err(`$.routing.${k}`, 'expected a list of sink names'));
        } else if (Array.isArray(v)) {
          // A sink name nobody can build routes alarms into silence. Warn rather
          // than error: unknown names stay tolerated (additive-tolerant parsing),
          // but the user is told, which is the whole difference from a typo that
          // costs them the alarm they thought they had configured.
          for (const name of v) {
            if (typeof name === 'string' && !(KNOWN_SINK_IDS as readonly string[]).includes(name)) {
              diagnostics.push(
                warn(
                  `$.routing.${k}`,
                  `unknown sink \`${name}\` — alarms routed here are dropped. Known sinks: ${KNOWN_SINK_IDS.join(', ')}`,
                ),
              );
            }
          }
        }
      }
    }
  }

  return { config: buildConfig(d), diagnostics };
}

/** True when nothing in the file will be ignored. */
export const hasErrors = (diagnostics: Diagnostic[]): boolean => diagnostics.some((x) => x.level === 'error');
