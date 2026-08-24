/**
 * Plain-language explanations for every number the UI shows, condensed from
 * docs/GLOSSARY.md. Lives in core so the panel, the widget and the CLI all
 * read the same words — there is exactly one place to fix a wrong explanation.
 *
 * Core stays UI-agnostic: this is a typed string table, not a renderer.
 *
 * Writing rules (docs/UI.md § copy):
 *  - say what it is, then what it means for a decision
 *  - name the provenance explicitly — measured, exact, or derived
 *  - no jargon that is not defined on the spot
 */
export type Provenance = 'measured' | 'exact' | 'derived';

export interface Explanation {
  title: string;
  body: string;
  /** Rendered as a small tag; absent for things that are not numbers. */
  provenance?: Provenance;
}

export const PROVENANCE_NOTE: Record<Provenance, string> = {
  measured: 'Read from the vendor. Not computed by Adjent.',
  exact: 'Counted from the agent transcripts. The same numbers billing uses.',
  derived: 'Worked out by Adjent from a fitted model. Shown with ≈ because it is an estimate.',
};

export const EXPLANATIONS: Record<string, Explanation> = {
  hero: {
    title: 'Utilization of the binding limit',
    body:
      'How much of the limit that will stop you first has been used. This is the one number Adjent leads with, because it is read straight from the vendor and stays correct even if everything else here is wrong.',
    provenance: 'measured',
  },
  binding: {
    title: 'Why this limit',
    body:
      'The binding limit is whichever one runs out first — not the fullest one. A weekly limit at 84% with six days left is less urgent than a 5-hour limit at 60% with forty minutes left. If the vendor names an active limit, that wins outright.',
  },
  burnRate: {
    title: 'Burn rate',
    body:
      'How fast utilization is climbing, in percentage points per hour, smoothed over about fifteen minutes. Pure arithmetic on the reported percentage — no tokens and no modelling involved.',
    provenance: 'measured',
  },
  resets: {
    title: 'Reset countdown',
    body:
      'When this limit rolls over and utilization drops back down. Limits are rolling: usage also ages off the back continuously, so the number can fall while you are still working.',
    provenance: 'measured',
  },
  verdict: {
    title: 'Verdict',
    body:
      'On pace, ahead of pace, or over. Ahead of pace is not automatically bad — it only matters if the projection says you run out before the limit resets.',
  },
  paceLine: {
    title: 'The pace line',
    body:
      'Where utilization would be if you spent the limit evenly over its period. Two hours into a five-hour limit, the pace line sits at 40%. The gap between your curve and that line is the whole point of the chart.',
  },
  chart: {
    title: 'Burn against the pace line',
    body:
      'Your utilization over the current period. The dashed diagonal is even spending; above it means you are burning faster than even. The dotted continuation projects your current rate forward — if it crosses the top before the right edge, you run out before the reset.',
  },
  exhausts: {
    title: 'Projected exhaustion',
    body:
      'Where your current burn rate reaches 100%. A forecast, not a reading — it moves as your rate changes, and it disappears entirely when you stop spending.',
    provenance: 'derived',
  },
  tokens: {
    title: 'Tokens this session',
    body:
      'Exact token counts from the transcripts, deduplicated per request. Cache reads dominate the raw total and cost far less than output tokens, which is why a big number here does not mean a big quota hit.',
    provenance: 'exact',
  },
  agentBurn: {
    title: 'What this agent is costing you',
    body:
      "This agent's share of the limit per hour. The vendor reports nothing per-agent, so Adjent prices its tokens through a rate it learns by watching how the reported percentage moves. Same unit as the big number, so they are directly comparable.",
    provenance: 'derived',
  },
  otherLimits: {
    title: 'Your other limits',
    body:
      'Every limit the vendors report, collapsed to one line. A scoped limit covers one model only — those are often the first to bind, even when your overall usage looks fine.',
    provenance: 'measured',
  },
  scoped: {
    title: 'Scoped limit',
    body:
      'A limit that applies to one model rather than everything. It can sit far higher than your overall usage, which is exactly why hiding it would be misleading.',
    provenance: 'measured',
  },
  stale: {
    title: 'Why this reading is old',
    body:
      'Codex writes its quota to disk only when it talks to its API, so while Codex is idle the number is frozen at the last turn. That is still correct — utilization only rises when the agent is working — but Adjent shows you when it was taken rather than pretending it is live.',
  },
  confidence: {
    title: 'Fit confidence',
    body:
      'How much to trust the ≈ numbers. Adjent cross-checks the per-agent rates against the vendor-reported rate; the two are computed by completely different routes, so their agreement is evidence the model is sound. Low early on, and it improves as your usage varies across models. This is per vendor — each meters differently, so each is fitted separately and an agent is only ever priced with its own vendor\'s weights. What you see here belongs to the vendor whose limit is currently binding, so it can change when the hero moves to the other vendor, which has its own history and may be less far along.',
  },
  epsilon: {
    title: 'Consistency residual (ε)',
    body:
      'The gap between what the vendor says you burned and what the per-agent numbers add up to. Small and steady means the model is working. Persistently large means something is burning quota that Adjent cannot see — another machine, or a backend with no adapter.',
    provenance: 'derived',
  },
  effort: {
    title: 'Reasoning effort',
    body:
      'How hard the model was asked to think. Higher effort produces more thinking tokens, which are billed as output tokens — so it shows up in the counts already, rather than costing extra per token.',
  },
  model: {
    title: 'Model',
    body:
      'The model this agent used on its most recent turn. Models differ enormously in cost per token, which is why Adjent prices each one separately once it has seen enough varied usage to tell them apart.',
  },
  idle: {
    title: 'Idle agent',
    body:
      'The session is still open but has not produced a turn recently. It costs nothing while idle; it is listed so you know it is there.',
  },
  liveCount: {
    title: 'Live agents',
    body: 'Sessions that produced a turn in the last few minutes, across every backend Adjent can see.',
  },
};

/** Lookup helper shared by the CLI's `explain` command. */
export function explain(key: string): Explanation | null {
  return EXPLANATIONS[key] ?? null;
}

export const EXPLANATION_KEYS = Object.keys(EXPLANATIONS);
