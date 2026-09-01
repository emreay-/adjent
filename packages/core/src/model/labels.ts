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
 * The tail of an agent's id, which is where the entropy lives.
 *
 * Codex thread ids are time-ordered and 36 characters long, so their *first*
 * eight characters are shared by every session started in the same period —
 * in a synthetic example, six agents can share one 8-character prefix while
 * their last eight characters are distinct. Both
 * providers build their fallback `label` from the head, which is why six rows
 * read `demo-api · 11111111`.
 */
const idTail = (id: string, n = 8): string => {
  const own = id.split(':').pop() ?? id;
  return own.length <= n ? own : own.slice(-n);
};

/**
 * id → the label to show, for one set of agents considered together.
 *
 * **The returned labels are unique.** That is the contract, and the reason this
 * is a set operation rather than a per-agent function: whether an agent needs
 * more than its project name depends entirely on the others. An earlier version
 * promised only to disambiguate the *project*, which left six rows reading the
 * same thing when the thing it disambiguated with was itself ambiguous.
 *
 * Callers must build it from *every* agent they know about, not just the ones
 * that fit on screen, or a row would change its name depending on what else was
 * visible.
 *
 * Three passes, each applied only to what is still ambiguous, so nothing gains
 * detail it does not need (UI.md: cut ruthlessly):
 *   1. the project's directory name;
 *   2. plus the vendor's session name, where it says something the project
 *      does not;
 *   3. plus the tail of the session id, which is unique when nothing else is.
 */
export function agentLabels(agents: readonly Agent[]): Map<string, string> {
  const out = new Map<string, string>();
  const base = new Map<string, string>();
  for (const a of agents) base.set(a.id, projectName(a) ?? a.label ?? idTail(a.id));

  /** ids whose current label is shared with at least one other agent. */
  const collidingIds = (current: Map<string, string>): Set<string> => {
    const byLabel = new Map<string, string[]>();
    for (const [id, label] of current) {
      const group = byLabel.get(label);
      if (group === undefined) byLabel.set(label, [id]);
      else group.push(id);
    }
    const out2 = new Set<string>();
    for (const group of byLabel.values()) if (group.length > 1) for (const id of group) out2.add(id);
    return out2;
  };

  for (const [id, label] of base) out.set(id, label);

  // Pass 2: the session name, for those that still collide.
  let ambiguous = collidingIds(out);
  if (ambiguous.size > 0) {
    for (const a of agents) {
      if (!ambiguous.has(a.id)) continue;
      const b = base.get(a.id) as string;
      if (a.label && a.label !== b) out.set(a.id, `${b} · ${a.label}`);
    }
  }

  // Pass 3: the id tail. Ids are unique, so this terminates the problem rather
  // than moving it — the session name may itself be an ambiguous id fragment,
  // which is exactly the case that produced six identical rows.
  ambiguous = collidingIds(out);
  if (ambiguous.size > 0) {
    for (const a of agents) {
      if (!ambiguous.has(a.id)) continue;
      out.set(a.id, `${base.get(a.id) as string} · ${idTail(a.id)}`);
    }
  }

  return out;
}
