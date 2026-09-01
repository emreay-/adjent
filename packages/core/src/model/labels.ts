/**
 * What to call an agent in a list.
 *
 * The project's directory name is the right label almost always — it is what
 * you recognise a session by, and it is short enough for a tray panel row. But
 * two sessions in one repository then render as two rows reading the same word,
 * which is what a user reported on 2026-08-27: they look like duplicates, or
 * like subagents leaking into a list that should not contain them.
 *
 * So disambiguate only when it is actually ambiguous (UI.md: cut ruthlessly).
 * A lone session in a project keeps the bare project name; sessions that would
 * collide gain the vendor-supplied session name, or a short id when the vendor
 * gave no name.
 *
 * This lives in core because both shells need it and they were drifting: the
 * panel got the fix and the CLI did not, so `adjent agents` still printed four
 * identical rows. `packages/desktop/src/renderer/panel.js` mirrors it — the
 * renderer is a plain browser script and cannot import from core, the same
 * arrangement `isKnownModel` already has. Change both together.
 */
import type { Agent } from './types.js';

/** Directory name of an agent's project, or null when it has no path. */
export function projectName(a: Pick<Agent, 'projectPath'>): string | null {
  if (!a.projectPath) return null;
  const parts = a.projectPath.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/**
 * id → the label to show, for one set of agents considered together.
 *
 * A map rather than a per-agent function because ambiguity is a property of the
 * set: whether this agent needs its session name depends on the others.
 * Callers must build it from *every* agent they know about, not just the ones
 * that fit on screen, or a row would change its name depending on what else was
 * visible.
 */
export function agentLabels(agents: readonly Agent[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const a of agents) {
    const key = projectName(a) ?? a.label;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  for (const a of agents) {
    const project = projectName(a);
    if (project === null) {
      out.set(a.id, a.label);
      continue;
    }
    if ((counts.get(project) ?? 0) < 2) {
      out.set(a.id, project);
      continue;
    }
    // `label` is the vendor's session name where it gave one, and a short id
    // where it did not — in which case it equals nothing useful, so fall back
    // to the id's own tail.
    const distinct = a.label && a.label !== project ? a.label : (a.id.split(':').pop() ?? a.id).slice(0, 8);
    out.set(a.id, `${project} · ${distinct}`);
  }
  return out;
}
