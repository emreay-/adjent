/**
 * Argument parsing, without a dependency.
 *
 * Deliberately strict about unknown flags: a script that types `--jsn` and gets
 * human output would silently feed a parser the wrong thing, so an unrecognised
 * flag is a usage error (exit 2) rather than something to shrug at.
 */

export interface Flags {
  /** Machine-readable output on stdout. Implies non-interactive. */
  json: boolean;
  /** Print nothing; the exit code is the whole answer. */
  quiet: boolean;
  /** Positional arguments, in order, with flags removed. */
  positional: string[];
  /** Values for flags that take one, e.g. `--limit 7d`. */
  values: Record<string, string>;
}

export interface ParseResult {
  flags: Flags;
  /** Non-null when parsing failed; the caller exits 2 with this on stderr. */
  error: string | null;
}

/**
 * Flags that take a value. Everything else is boolean, so `--json --quiet`
 * parses without a schema per command.
 */
export const VALUE_FLAGS = new Set([
  'limit',
  'backend',
  'budget',
  'max-utilization',
  'max-age',
  'pace',
  'interval',
  'against',
  'rules',
  'preset',
  // `gate hold`. Unknown flags are a hard exit-2 error, so a value flag that is
  // not listed here does not degrade — the command simply refuses to run.
  'reason',
  'until',
]);

const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'help', 'prime', 'force']);

export function parseArgs(argv: string[]): ParseResult {
  const flags: Flags = { json: false, quiet: false, positional: [], values: {} };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('-')) {
      flags.positional.push(a);
      continue;
    }
    // `--` ends flag parsing; everything after is positional.
    if (a === '--') {
      flags.positional.push(...argv.slice(i + 1));
      break;
    }
    // Support both `--flag value` and `--flag=value`.
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a : a.slice(0, eq)).replace(/^--?/, '');
    const inline = eq === -1 ? null : a.slice(eq + 1);

    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) return { flags, error: `--${name} needs a value` };
      flags.values[name] = value;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== null) return { flags, error: `--${name} does not take a value` };
      if (name === 'json') flags.json = true;
      else if (name === 'quiet') flags.quiet = true;
      else flags.values[name] = 'true';
      continue;
    }
    return { flags, error: `unknown flag: ${a}` };
  }

  return { flags, error: null };
}

/**
 * A percentage written the way a person would: `20`, `20%`, `20.5%`.
 * Returns null rather than NaN so callers must handle the bad case.
 */
export function parsePercent(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.trim().replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

/** A duration written the way a person would: `90s`, `15m`, `2h`, `7d`. */
export function parseDuration(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'm';
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit] as number;
  return n * scale;
}
