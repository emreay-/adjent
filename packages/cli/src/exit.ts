/**
 * Exit codes, fixed by docs/API.md.
 *
 * A script branches on these instead of parsing output, so they are a contract:
 * a new meaning takes a new number, never a reused one.
 *
 * The distinctions that matter: `NO_DATA` and `PREDICATE_FAILED` are successful
 * evaluations, not errors. A machine with no agent installed, and a budget gate
 * answering "no", are both Adjent working correctly — which is why neither is
 * `INTERNAL_ERROR`.
 */
export const EXIT = {
  OK: 0,
  INTERNAL_ERROR: 1,
  USAGE: 2,
  NO_DATA: 3,
  PREDICATE_FAILED: 4,
  STALE: 5,
  CONFIG_INVALID: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
