# Why token counts don't tell you your remaining subscription quota

A coding agent can read a large cached context and produce a short answer.
Another can read little and generate a long answer. Adding their tokens gives a
useful activity total, but it discards the mix of work that produced it.

[Adjent](../../README.md) keeps two questions separate: **how full is the
vendor's limit, and which local sessions appear to be spending it?** The first
comes from a reported quota reading. The second needs an estimate.

All numbers below are synthetic illustrations, not measured account usage or
claims about a vendor's subscription pricing.

## Counting is exact; the conversion is learned

Suppose two workers each consume 100,000 tokens:

| Worker | Cache reads | Output | Total |
| --- | ---: | ---: | ---: |
| A | 90,000 | 10,000 | 100,000 |
| B | 20,000 | 80,000 | 100,000 |

Invent weights of one unit per cache-read token and five per output token.
Worker A consumes 140,000 weighted units; B consumes 420,000. Equal raw totals
now correspond to a threefold difference. These weights illustrate the problem;
they are not Adjent's estimate or a published quota formula.

Local counters can be added exactly, subject to what the parser actually saw.
They cannot establish account coverage: another device, missing records or a
history still catching up can contribute usage that is absent locally.

## Why a quota percentage can stay flat while work continues

For the trailing-window model described in Adjent's design, consumption enters
at the front while older consumption ages out at the back. If new work adds
three percentage points while old work releases two, reported utilization
increases by only one point. The worker still consumed three points of gross
capacity under that model.

The useful equation is:

```text
change in utilization ≈ sum over buckets of:
    fitted weight × (consumption entering − consumption aging out)
```

A bucket normally identifies a model and token kind. Repeated observations
provide equations for the unknown weights. Adjent fits non-negative weights
and regularizes toward a prior, so noisy observations do not freely push the
solution into implausible values. API price ratios provide a starting shape;
they do not establish how subscriptions are metered.

This is a modelling assumption about the relationship, not a vendor contract.
Undocumented formats, different reset behavior and incomplete local history can
break the assumptions. The reported percentage remains authoritative even when
the fitted attribution is unavailable or wrong.

## More observations are not always more information

If every request has the same ratio of cache reads to output, many different
weights explain the same quota changes. Repeating that request a thousand
times does not separate those weights. Statisticians call this an
*identifiability* problem.

A blended estimate needs less information than a per-model, per-kind
decomposition. Adjent's fit can fall back to coarser resolutions; before it has
enough evidence, a per-agent rate is unknown. Unknown is not zero.

Once weights are available, attribution follows the same units:

```text
agent burn in percentage points/hour
    ≈ sum(agent consumption per hour × fitted bucket weight)
```

That is why the panel can show a plain reported percentage beside an estimated
`≈` per-agent burn. They answer different questions with different evidence.

## Check the assumptions, not just the arithmetic

A residual is the gap between a model's prediction and the observed change.
Persistent disagreement can motivate checking coverage, duplicate events or
the assumed weights. A small residual alone does not prove attribution is
correct: moving tokens between two agents without changing the total can leave
the residual unchanged.

The full derivation covers regularization, cold start, resolution selection,
reasoning-effort assumptions and proposed residual diagnostics in
[the glossary](../GLOSSARY.md#the-model-derived). Proposed diagnostics there
should not be read as already implemented features.

To inspect a safe example, follow the [synthetic walkthrough](README.md#reproduce-it).
To interpret your own snapshots, use the [provenance contract](../API.md#provenance)
and [data-source limitations](../DATA-SOURCES.md). Adjent is early WIP; derived
burn is an aid to decisions, not a bill or a guaranteed allowance for future work.
