# Glossary

Two kinds of vocabulary here, and it matters which is which.

**Spec words** are for us, writing the design down. They never appear on screen.
The panel shows "resets in 2h 41m", not "the countdown in the primary read".

**Product words** are things the user sees and should recognise.

---

## Spec words — how we talk about the layout

| Term | Plain meaning |
| --- | --- |
| **Panel** | The small limit that opens when you click the tray icon. |
| **At rest** | What the panel shows before you click anything. The opposite of "behind a click". |
| **Primary read** | The top block: verdict, big number, rate, countdown, chart. The part you see in the first second. It has a name only so we can put a hard cap on what goes in it. |
| **Hero number** | The single biggest number on the panel; there is exactly one. In Adjent it is always the same metric: **vendor-reported utilization of the binding limit** — measured, never derived, so it survives total failure of the modelling layer. Its rate and reset countdown sit beside it as modifiers, not rivals. See [UI.md](UI.md#the-hero-number-exactly). |
| **Token line** | The one small line under the chart showing raw token counts. *(Previously called "receipt line" — renamed, it was cuter than it was clear.)* |
| **Agent row** | One line per running agent. |
| **Progressive disclosure** | Detail is hidden until you click for it. |
| **Tier 1–5** | How deep something is: tier 1 is the tray icon, tier 5 is settings. |

## Product words — what the numbers mean

| Term | Plain meaning |
| --- | --- |
| **Backend** | A coding agent installed on your machine — Claude Code, Codex, and later others. |
| **Vendor** | The company whose service a backend talks to: Anthropic for Claude Code, OpenAI for Codex. Used specifically to mean *the authority that defines and reports your quota*. "Vendor-reported" is the strongest provenance a number can have in Adjent — it means we read it rather than computed it, and we never override it. |
| **Limit** | One of your usage ceilings: a percentage that fills over a period, then resets. Claude has a 5-hour and a 7-day one plus per-model scoped ones; Codex has its own. Called a *limit* rather than a *window* because in a desktop app a window is a UI element — and because it is the vendors' own word (`limits[]`, `rate_limits`, `/usage`). The underlying period is still a rolling **window** in the maths below, where that is the standard term. |
| **Utilization** | The percentage the vendor says you have used of a limit. We do not compute this — we read it. |
| **Binding limit** | Of all your limits, the one that will stop you first. Not necessarily the fullest one: 84% of a weekly limit with six days left is less urgent than 60% of a 5-hour limit with 40 minutes left. The hero number always shows the binding limit. Selection rule: vendor's `is_active` flag if present, else earliest projected exhaustion among limits that run out before they reset, else highest utilization — with hysteresis so the choice holds still. Full rule in [UI.md](UI.md#choosing-the-binding-limit). |
| **Burn rate** | How fast utilization is climbing, in **percentage points per hour** (`%/h`). |
| **Pace line** | The diagonal on the chart: where utilization *would* be if you spent the limit evenly. Two hours into a five-hour limit, the pace line is at 40%. |
| **Ahead of pace** | Above the pace line — spending faster than even. Not automatically bad; it is bad if the projection says you run out early. |
| **Projection** | The dotted line: where your current burn rate lands you. |
| **Exhausts at** | When the projection hits 100%. If that is before the limit resets, you run out. |
| **Verdict** | The one-word summary: *On pace* / *Ahead of pace* / *Over*. |
| **Agent** | One running session of one backend, in one project. Subagents are counted separately and attributed to their parent. |

## Modelling words — the derived layer

| Term | Plain meaning |
| --- | --- |
| **Token kind** | Which of the four prices a token was charged at: input, cache write, cache read, or output. They differ by roughly 50× end to end, so mixing them is meaningless. |
| **Reasoning effort** | How hard a model was asked to think on a turn — low / medium / high / xhigh / max. Recorded per turn by both backends. It drives token *volume*, not token *price*, so it is deliberately **not** part of the bucket key — see [why](#why-reasoning-effort-is-not-a-bucket-dimension). |
| **Bucket** | One billable quantity the vendor meters — normally a (model × token kind) pair such as "Opus output tokens", but also non-token charges like a web-search request. The unit the weights are learned over. |
| **Weight** | How many percentage points one token of a given bucket costs. Learned, not assumed. |
| **Weighted tokens** | Raw tokens after applying weights, so a cache read and an output token are on the same scale. Raw token totals are dominated by cache reads and say very little on their own. |
| **Exchange rate** | The headline version of the weights: how many tokens equal one percentage point. Quoted per kind, because a blended figure hides the 50× spread. |
| **Published API price ratios** | Both vendors publish per-million-token prices for *API* use, per model and per token kind. Adjent ignores the absolute dollars and keeps only the **ratios** — for Opus, roughly: input 1×, cache write 1.25×, cache read 0.1×, output 5×; and across models, Opus ≈ 5× Sonnet. These are a starting guess, not truth: nothing states that subscription quota is metered the same way API billing is. The shape is almost certainly right, the exact numbers may not be — which is exactly what a *prior* is for. |
| **Prior** | A starting belief about an answer, held before seeing any data, that observation is then allowed to correct. Adjent's prior is the price ratios. |
| **Hat** ( $\hat{w}$ ) | Standard statistics notation for "our estimate of". $w$ is the true weight, unknown and unknowable directly; $\hat{w}$ is the number we fitted from data. Everything Adjent displays that involves weights is built on $\hat{w}$, never $w$ — which is why those numbers carry `≈`. |
| **NNLS** | Non-negative least squares. Ordinary least squares, plus the constraint that every fitted value must be ≥ 0. A standard, solved problem. |
| **λ (lambda)** | The regularisation strength — the dial between "trust the data" and "trust the prior". See [the estimator](#step-4-stop-the-fit-thrashing-regularisation) below. |
| **EWMA** | Exponentially weighted moving average — a cheap way to smooth a jittery series. See [smoothing](#why-smoothing-is-required-not-cosmetic). |
| **Cold start** | The state before Adjent has enough observations to fit anything. See [Cold start](#cold-start-what-adjent-knows-and-when). |
| **Fit residual** ( $e_n$ ) | How much the model's prediction misses the measurement by, on one poll. Signed. Small *and unbiased across subgroups* means the model is right — see [the miss](#the-miss-and-why-it-is-the-most-useful-number-here). |
| **Consistency residual** ( $\varepsilon$ ) | The gap between gross burn as the vendor reports it (change plus aging-out) and gross burn summed over agents. Catches missed or double-counted consumption, which the fit residual structurally cannot. Drives the confidence indicator — see [the free consistency check](#the-free-consistency-check). |
| **Confidence** | How much to trust a derived number, from sample count and residual size. Shown as low / medium / high. |

---

# The model, derived

The goal of this whole section is one number: **how much quota did *this agent*
just burn?** The vendor will not tell us — it reports a single percentage for the
whole account. So we have to reconstruct it.

## Notation

| Symbol | Meaning | Units |
| --- | --- | --- |
| $W$ | window length | 5 h, 7 d |
| $K$ | the set of **buckets** — each $k \in K$ is one billable quantity the vendor meters, normally a (model, token kind) pair, but see [step 2](#tokens-is-too-narrow--the-feature-vector-is-billable-quantities) | e.g. Opus × output |
| $u(t)$ | utilization the vendor reports at time $t$ | percent |
| $c_k(a, b]$ | how much of bucket $k$ was consumed in the interval $(a, b]$ | tokens, or requests |
| $w_k$ | cost of one unit of bucket $k$ — **the unknown** | percent / unit |

### Reading the notation

Three typefaces mean three kinds of object. This is the standard linear-algebra
convention, written down once here so it is not a puzzle later:

| Form | Is a | Meaning |
| --- | --- | --- |
| $x_{n,k}$ — lowercase italic, subscripted | **scalar** — one number | the net flow of bucket $k$ at poll $n$ |
| $\mathbf{x}_n$ — lowercase **bold** | **vector** | every bucket at poll $n$, stacked: $\mathbf{x}_n = (x_{n,1}, \dots, x_{n,|K|})^\top$ |
| $X$ — uppercase | **matrix** | every poll stacked: row $n$ of $X$ is $\mathbf{x}_n^\top$ |

They are all **the same quantity** — consumption flowing through the window —
seen at three zoom levels: one bucket at one poll, all buckets at one poll, all
buckets at every poll. The weights work identically: $w_k$ is one number,
$\mathbf{w}$ is the vector of all of them.

And $\mathbf{x}_n^\top \mathbf{w}$ is nothing more than shorthand for
$\sum_k x_{n,k} \, w_k$ — the $\top$ turns the column into a row so the
dimensions line up for the product. If the bold and the capitals ever get in the
way, mentally expand them back into the sum; nothing is lost.

## Step 1: what one poll actually tells us

Adjent polls the vendor for $u(t)$, and separately reads an exact token timeline
off disk. At poll $n$, taken at time $t_n$, the reported percentage moved by

$$\Delta u_n = u(t_n) - u(t_{n-1})$$

Two things caused that move. Tokens spent since the last poll pushed it **up**:

$$\text{in}_{n,k} = c_k(t_{n-1},\, t_n]$$

and tokens that got old enough to leave the trailing window pulled it **down**:

$$\text{out}_{n,k} = c_k(t_{n-1} - W,\, t_n - W]$$

That second term is the one people usually get stuck on, and it is why a rolling
window looks harder than it is. It is not a new quantity — it is the *same*
consumption function, evaluated one window-length earlier. Adjent holds the full
timeline, so it is exact, not estimated. Call the net effect

$$x_{n,k} = \text{in}_{n,k} - \text{out}_{n,k}$$

## Step 2: from one poll to an equation

We have a measured input, $x_{n,k}$, and a measured output, $\Delta u_n$. To
connect them we need a claim about *how* consumption turns into utilization. The
claim Adjent makes is that the relationship is **linear**:

$$\Delta u_n \approx \sum_{k \in K} w_k \, x_{n,k} = \mathbf{x}_n^\top \mathbf{w}$$

That one line is doing more work than it looks, so it is worth unpacking exactly
what is being assumed — because everything downstream inherits it, and because
each part of it turns out to be testable.

### What linearity actually asserts

**Additivity.** The cost of a set of tokens is the sum of the costs of its parts.
Spending output tokens does not change what a cache read costs. There are no
interaction terms — no $w_{jk}\,x_j x_k$ anywhere.

**Homogeneity — constant marginal cost.** The ten-millionth token of a bucket
costs exactly what the first one did. No tiering, no progressive rate as you
approach the limit, no volume discount. This is what lets a single scalar $w_k$
stand in for a whole bucket.

**Time-invariance within the window.** A token costs the same regardless of
*when* inside the window it was spent. This is what justifies treating the window
as a plain sum with a hard cut-off at $W$ — a rectangular kernel — rather than
something that decays with age. It is also what makes the $\text{out}$ term a
simple subtraction rather than a reweighting.

**No hidden per-request charge.** Cost is proportional to quantities consumed,
with nothing charged merely for making a call. In other words: no intercept.

### Why this is a reasonable claim

Not because linearity is convenient, but because it is how the metering visibly
works elsewhere. Both vendors bill API usage as exactly this sum — a per-token
rate, per kind, per model, added up, with no tiers and no per-call fee. A
subscription allowance is far more likely to be computed from the same internal
metering than from a second, differently-shaped one built alongside it.

There is also a structural argument. Utilization is reported as a percentage of a
fixed allowance. If the numerator is a weighted sum of consumption and the
denominator is a constant, then utilization is linear in consumption *by
construction* — the only question left is the values in $\mathbf{w}$, which is
precisely what we are fitting.

### "Tokens" is too narrow — the feature vector is billable quantities

Linearity does not require that every column of $X$ be a token count, and it
should not be. Each usage record also carries `server_tool_use`, counting web
search and web fetch requests, which are charged **per request** rather than per
token. They belong in $\mathbf{x}_n$ as their own columns, with weights in
percent *per request* instead of percent per token.

The model does not change at all — it is still a weighted sum of measured
quantities. Only the reading of $k$ widens: from "a token bucket" to **any
billable quantity the vendor meters**. In a synthetic example both counters may be zero; carrying the columns
still avoids silently mis-attributing a later non-token charge to nearby tokens.

### Turning the last assumption into a measurement

The no-intercept assumption is the shakiest of the four, and also the cheapest to
stop assuming. Add one more column to $X$: the number of requests in the
interval. Its fitted weight is then the per-request fixed cost, and the
hypothesis is tested rather than believed —

* fits to $\approx 0$ → there is no per-request charge, as expected;
* fits to something clearly positive → there is one, and it is now correctly
  accounted for instead of being smeared across the token weights.

One extra column converts an article of faith into a number.

### The miss, and why it is the most useful number here

The model is an approximation, so for any candidate weights it will miss. Give
the miss a name:

$$e_n = \Delta u_n - \mathbf{x}_n^\top \mathbf{w}$$

One signed number per poll, called the **fit residual**. Positive means the
vendor charged more than the model predicted; negative, less.

Everything downstream runs on $e_n$. Step 3 chooses $\mathbf{w}$ by making it
small. The tests below work by asking a sharper question — not *is it small*, but
**is it small evenly**. Noise scattered around zero is a healthy model. Residuals
that are near zero on average but systematically positive within some subgroup
mean an assumption is wrong, and *which* subgroup tells you which one.

### What would break linearity, and how we would see it

| If this were true | It would show up as |
| --- | --- |
| Progressive rates near the limit | $e_n$ trending upward with $u$ — stratify the residual by utilization |
| A priority or speed tier metered differently | $e_n$ biased on intervals with a given `service_tier` / `speed`. Both fields are already in every record and can become bucket dimensions if needed |
| Effort charged beyond its token count | $e_n$ biased by effort — see [the falsification test](#the-falsification-test) |
| Costs decaying with age rather than a hard cut-off | $e_n$ biased on intervals where much of the consumption sits near the trailing edge of the window |

The shape is the same every time: the residual is not merely a confidence
indicator, it is the diagnostic that says *which* assumption failed. That is the
practical reason to compute it continuously rather than only at fit time.

One thing that is **not** a violation, and is easy to mistake for one:
utilization arrives rounded to whole percent. That is quantisation noise on the
measurement, not curvature in the underlying relationship — and least squares
already handles it, which is part of why least squares is the right tool here.

### Stacking the polls

With the model settled, one poll gives one equation in $|K|$ unknowns. Stack $N$
polls into a matrix $X \in \mathbb{R}^{N \times |K|}$ whose $n$-th row is
$\mathbf{x}_n^\top$, and a vector $\Delta \mathbf{u} \in \mathbb{R}^N$ of the
observed moves:

$$\Delta \mathbf{u} \approx X \mathbf{w}$$

Everything in $X$ and $\Delta \mathbf{u}$ is measured. Only $\mathbf{w}$ is
unknown. This is now an ordinary linear system, and the rest is choosing how to
solve it well.

## Step 3: why not just solve it

With $N = |K|$ independent polls you could solve $X\mathbf{w} = \Delta\mathbf{u}$
exactly. You should not, for three reasons:

* **There are far more polls than buckets.** After an hour, $N$ is 60 and $|K|$
  is maybe 12. The system is *overdetermined* — no $\mathbf{w}$ satisfies every
  row.
* **The measurements are noisy.** Utilization arrives rounded to whole percent,
  and a request can land on either side of a poll boundary. Both put small errors
  into $\Delta \mathbf{u}$.
* **Exact solutions chase that noise.** Fitting 12 unknowns to exactly 12 noisy
  equations gives you a perfect fit to the noise and a bad answer.

The standard response to an overdetermined noisy linear system is **least
squares**: instead of demanding every row hold exactly, pick the $\mathbf{w}$
that makes the total squared miss as small as possible.

$$\min_{\mathbf{w}} \; \lVert X \mathbf{w} - \Delta \mathbf{u} \rVert_2^2 \;=\; \min_{\mathbf{w}} \; \sum_{n=1}^{N} e_n^2$$

The notation $\lVert \mathbf{v} \rVert_2^2$ just means "add up the squares of the
entries of $\mathbf{v}$". So this reads: *of all possible weight vectors, take the
one whose predictions miss the measurements by the least, totalled over every
poll.* Squared error is the natural choice here because it is the
maximum-likelihood answer when errors are independent and roughly Gaussian —
which rounding and timing jitter approximately are.

### Step 3b: rule out the impossible

Plain least squares has no idea what these numbers mean. If it fits the noise
slightly better by claiming cache-read tokens have a *negative* cost, it will.
Physically that would mean reading from cache hands you quota back.

So constrain every weight to be non-negative:

$$\min_{\mathbf{w} \,\ge\, 0} \; \lVert X \mathbf{w} - \Delta \mathbf{u} \rVert_2^2$$

Least squares plus that constraint is **non-negative least squares (NNLS)**, a
standard solved problem with well-known algorithms. Nothing exotic.

### Step 4: stop the fit thrashing — regularisation

One problem remains, and it is the real one in practice. If you always use Opus
output and Opus cache-read in roughly fixed proportion, then those two columns of
$X$ move together, and the fit cannot tell whether the cost sits on one or the
other. Many very different $\mathbf{w}$ explain the data equally well. The
consequence is visible: weights swing wildly between polls, and the per-agent
numbers built on them jump around.

The standard fix is **regularisation** — add a second term that penalises
straying from a sensible default, so that among all the near-equally-good
answers, the fit prefers the one closest to what we already believed:

$$\hat{\mathbf{w}} = \arg\min_{\mathbf{w} \,\ge\, 0} \; \underbrace{\lVert X \mathbf{w} - \Delta \mathbf{u} \rVert_2^2}_{\text{fit the data}} + \underbrace{\lambda \lVert \mathbf{w} - \mathbf{w}_0 \rVert_2^2}_{\text{stay near the prior}}$$

Reading it left to right: $\arg\min$ means "the $\mathbf{w}$ that minimises what
follows" — as opposed to $\min$, which would be the minimum value itself. We want
the weights, not the score. The result is written $\hat{\mathbf{w}}$, with a hat,
because it is our *estimate* of the true $\mathbf{w}$, not the thing itself.

| Symbol | What it is |
| --- | --- |
| $\hat{\mathbf{w}}$ | the fitted weights — our best estimate of the true $\mathbf{w}$ |
| $\mathbf{w}_0$ | the **prior**: the published API price ratios, scaled (see cold start) |
| $\lambda$ | **regularisation strength** — how hard to pull toward the prior |

$\lambda$ is a dial between two failure modes:

* $\lambda \to 0$ — ignore the prior, trust the data completely. Correct once you
  have a lot of varied data; unstable before that.
* $\lambda \to \infty$ — ignore the data, return the prior. Stable but never
  learns anything.

So Adjent does not pick one value. It starts $\lambda$ high and decays it as
observations accumulate:

$$\lambda_N = \frac{\lambda_0}{1 + N / N_0}$$

where $N$ is the number of usable samples and $N_0$ sets how fast trust shifts.
The fit therefore *begins* as "published prices" and *becomes* "your measured
reality", with no switch to flip and no moment where the number lurches.

### Why reasoning effort is *not* a bucket dimension

A fair objection: the bucket key is (model × token kind), but a turn also has a
reasoning effort — low / medium / high / xhigh / max. Should that be in $K$?

The current model assumes **effort changes how many tokens a turn produces,
not the weight of each token kind**. That is a hypothesis to test, not something
a synthetic example can establish about vendor metering.

Consider this synthetic 800-turn illustration. Counts, medians and shares are
invented to show the mechanism; no account dataset is being reproduced:

| Model | Effort | Turns | Median output | Thinking share of output |
| --- | --- | ---: | ---: | ---: |
| model-x | high | 300 | 300 | 20% |
| model-x | xhigh | 100 | 450 | 30% |
| model-x | max | 100 | 600 | 40% |
| model-y | medium | 100 | 200 | 15% |
| model-y | high | 200 | 350 | 25% |

Two distinctions matter. Thinking tokens are treated as *inside* output when
that is how the vendor defines the counters; adding them as a second output
charge would double-count. Separately, this example assigns higher output and
thinking shares to higher effort. Those changes are already visible in the
existing token-kind counts. A thinking token need not become a new bucket merely
because the model spent more of its output on reasoning.

Under that hypothesis, adding effort to the bucket key adds a dimension with
no additional price information — and it would cost real statistical power. $|K|$ goes from ~12 to
~60, and separating 60 columns needs far more varied data than 12. Given that
near-collinear columns are already the main practical failure mode (see
[step 4](#step-4-stop-the-fit-thrashing--regularisation)), that is a bad trade.

Effort can shift the *mix* toward output, but that does not imply that total
weighted consumption scales by the same factor. As a separate synthetic worked
example, hold the non-output contribution at 7 units and output at 3 units:
doubling output changes the total from 10 to 13 units, only **1.3×**. Raw token
volume, the mix of token kinds, and weighted quota consumption are different
quantities. Cache reads may dominate volume while output contributes a larger
share of cost per token.

#### The falsification test

All of the above assumes the vendor meters quota on tokens, not on effort
directly. We do not have to assume it — the [fit residual](#the-miss-and-why-it-is-the-most-useful-number-here)
tests it for free. Group the polls by the effort of the turns they contain and
take the mean residual of each group:

$$\bar{e}_{\,\text{eff}} = \operatorname{mean}\big(\, e_n \;\big|\; \text{turns in } (t_{n-1},\, t_n] \text{ ran at effort } \text{eff} \,\big)$$

If effort were metered beyond its token count, high-effort groups would show a
**systematic positive bias** — $\bar{e}$ reliably above zero — rather than noise
scattered around it. If that fires, the fix is mechanical: extend the bucket key from
(model, kind) to (model, kind, effort) and let the fit price it. Until it fires,
adding the dimension is speculation that costs accuracy.

This is the general pattern worth keeping: *do not add a modelling dimension
because it might matter — instrument for it, and let the residual decide.*

#### Where effort does belong

Not in $K$, but three places:

* **On the agent row**, because it is the single best predictor of whether a burn
  rate will persist — an `xhigh` session will keep burning at that rate.
* **In the projection**, for the same reason.
* **As the cheapest lever** in the actions expansion: downshifting effort cuts
  burn without stopping the work.

**Identifiability.** Even with all this, $\hat{\mathbf{w}}$ is uniquely
determined only if $X$ has full column rank — that is, if your usage mix actually
varies across buckets.

A hypothetical design matrix can illustrate the distinction using its condition
number: the ratio of the largest to smallest singular value. Small is well-posed;
infinite means rank-deficient. These are illustrative values, not fitted results. The column counts below
describe the token portion; the implementation also includes a request-count
column at the finer resolutions:

| Resolution | Token columns | Illustrative cond($X$) | Verdict |
| --- | ---: | ---: | --- |
| model × kind | 16 | $\infty$ | ill-posed |
| kind only | 4 | about 900 | poorly conditioned |
| blended (one nonzero column) | 1 | 1 | no ambiguity between columns |

For a concrete construction, if every row has twice as many cache-read tokens
as output tokens, those two columns are proportional. More repetitions cannot
separate their weights. Small variations can make the matrix full-rank while
leaving it poorly conditioned: mathematically solvable, statistically unstable.
A single nonzero blended column removes the between-column ambiguity; it still
needs a useful observed change to bootstrap a scale.

The lesson in the middle row: even *kind-only* can be unstable, because within one
workflow the kinds arrive in near-fixed proportions — every turn carries a big
cache read, a small cache write, and some output, in roughly the same ratio. Same
direction every poll, so the columns barely span anything.

**What actually makes the fit identifiable is variety of *sessions*, not
volume of tokens.** Concretely, the data starts separating columns when it
contains contrasts like:

* a **Haiku-only stretch** next to an **Opus-only stretch** — separates the
  models' scales;
* a **fresh session** (cache writes, few reads) next to a **long resumed one**
  (huge reads, no writes) — separates cache write from cache read;
* a **plan-heavy hour** (mostly thinking/output) next to a **search-heavy hour**
  (mostly input and reads) — separates output from input;
* **quiet gaps**, where the window drains with no inflow — these are the
  cleanest rows of all: $\Delta u$ driven purely by the $\text{out}$ term.

None of this needs to be arranged. Normal work over a week or two contains it.
What never becomes identifiable is a usage diet that is genuinely uniform — one
model, one workflow shape, all day — and for that the honest answer *is* the
blended rate.

So Adjent does not pick one resolution. It fits a **hierarchy** — blended, by
kind, by model × kind — and per level reports the finest weights whose
uncertainty is acceptable, falling back one level where the data is collinear.
The blended level is always solvable (one column cannot be collinear with
anything), which is why a usable per-agent number exists from the first day
even though per-model exchange rates may take weeks or never arrive.

---

## Cold start: what Adjent knows, and when

The prior has a shape but no scale. Price *ratios* tell us output tokens cost
about 50× cache reads; they do not tell us how many tokens make one percent of
your particular plan's window. So write the prior as a direction times a scale:

$$\mathbf{w}_0 = s_0 \, \mathbf{p}$$

where $\mathbf{p}$ is the normalised price-ratio vector and $s_0$ is a single
unknown scalar. One usable observation is enough to fix it:

$$s_0 = \frac{\Delta u_1}{\mathbf{p}^\top \mathbf{x}_1}$$

That is the entire bootstrap: **the ratios give the shape, the first real
observation gives the scale.**

What the user sees at each stage:

| Stage | Condition | Behaviour |
| --- | --- | --- |
| **Cold** | no polls yet | Hero number and its rate work normally — they need no model at all. Per-agent rates read *"learning"*, not `0` and not a guess. |
| **Bootstrapped** | one poll with real consumption | $s_0$ fixed; per-agent rates appear, marked **low** confidence. |
| **Warming** | a few hours of varied use | $\lambda$ has decayed; if the model mix varies, per-model weights start to separate. Confidence **medium**. |
| **Settled** | $\varepsilon$ small and stable | Confidence **high**. Per-kind exchange rates are quotable. |

Two practical notes. The fit is **persisted** to `~/.adjent`, so a cold start
happens once per machine, not once per launch. And it is **invalidated when the
allowance changes size** — see below.

### What "plan change" means, precisely

A distinction the wording above blurred: the **window lengths** are indeed
constants of the vendor's product — Claude's 5 hours and 7 days do not change.
What changes is the **denominator**: how much consumption fits inside a window
before it reads 100%. The weights have that denominator baked in ($w_k$ is
percent per token — percent *of a specific allowance*), so when the allowance
grows 4×, every weight is suddenly wrong by exactly 4×.

When does that actually happen? Rarely, but each is real:

* **You change subscription tier.** Pro → Max 5× → Max 20×. This is the big one,
  and it is visible: `.credentials.json` carries `rateLimitTier`
  (synthetic example: `demo-tier`) and Codex's rollouts carry
  `plan_type`. Watch the string; when it changes, re-bootstrap.
* **The vendor reprices the plan.** Same tier string, silently different
  allowance — vendors adjust subscription limits over time. Invisible in
  metadata, but it surfaces as a **sudden, persistent** jump in the fit residual
  $e_n$: the model keeps predicting with old weights and starts missing by a
  consistent factor. A step-change detector on $e_n$ catches it; the response is
  the same re-bootstrap.
* **Temporary metering states.** Overage/extra-usage credits, promotional
  windows, degraded-service periods. The usage endpoint exposes several of these
  directly (`extra_usage`, overage headers), so most can be detected rather than
  inferred.

The rule that covers all three: the tier string and the residual are both
watched, and either one can trigger the drop back to bootstrapped. Re-learning
after a re-bootstrap is fast, because the price *ratios* are still right — only
the scale $s_0$ has to be re-estimated, and one usable observation fixes it.

---

# How burn rate is computed

Two different numbers, two different methods. This distinction is the one worth
holding on to.

## Window burn rate — measured, no model involved

The hero rate. Pure arithmetic on numbers the vendor gives us:

$$r(t) = \frac{u(t) - u(t - h)}{h}, \qquad h = 15\ \text{min}$$

| Symbol | Meaning |
| --- | --- |
| $r(t)$ | limit burn rate at time $t$, in percentage points per hour |
| $u(t)$ | vendor-reported utilization, percent |
| $h$ | lookback for the difference — 15 minutes, expressed in hours so the units come out as `%/h` |

That is the whole thing. **No weights, no tokens, no fit.** If the modelling
layer never worked at all, the hero number and its rate would still be correct —
which is exactly why they are what the panel leads with.

One property worth knowing: on a rolling window, utilization can *fall* while you
are still spending, because old usage ages off the back. The measured rate
already accounts for that, and should — it is the real trajectory of the number
that actually constrains you.

### Why smoothing is required, not cosmetic

Utilization arrives rounded to whole percent. Between two polls a minute apart it
typically moves by 0 or 1. Put that straight into the formula above and the
"rate" alternates between `0 %/h` and `60 %/h` — useless, and it would make the
verdict chip flicker.

So $r$ is smoothed with an **EWMA** — an exponentially weighted moving average.
Rather than averaging the last $N$ samples equally, it weights recent samples
more, with the weight of older ones decaying geometrically. It is a one-line
recursion holding a single number of state:

$$\bar{r}_n = \alpha \, r_n + (1 - \alpha) \, \bar{r}_{n-1}, \qquad 0 < \alpha \le 1$$

| Symbol | Meaning |
| --- | --- |
| $r_n$ | the raw rate computed at poll $n$ |
| $\bar{r}_n$ | the smoothed rate reported at poll $n$ |
| $\alpha$ | smoothing factor: near 1 is responsive and jumpy, near 0 is smooth and laggy |

Rather than pick $\alpha$ by feel, derive it from a half-life $T_{1/2}$ — how
long until an old reading counts half as much:

$$\alpha = 1 - 2^{-\Delta t / T_{1/2}}$$

Adjent uses $T_{1/2} = 5$ minutes: a genuine spike shows up within a minute or
two, but no single noisy poll can dominate. The EWMA is reset — not merely
smoothed through — whenever the limit rolls over, since the drop to near-zero is
real and must not be averaged away.

## Per-agent burn rate — derived, needs the weights

The vendor reports nothing per-agent, so this one has to be built. It is the same
consumption function restricted to a single agent, priced through the fitted
weights:

$$r_a(t) = \frac{1}{\tau} \sum_{k \in K} \hat{w}_k \, c_{a,k}(t - \tau,\, t], \qquad \tau = 10\ \text{min}$$

| Symbol | Meaning |
| --- | --- |
| $a$ | one agent — a single session of one backend, in one project |
| $A(t)$ | the set of agents live at time $t$ |
| $r_a(t)$ | that agent's burn rate, in percentage points per hour |
| $\tau$ | the **measurement lookback** — 10 minutes, expressed in hours, so $1/\tau = 6$ |
| $c_{a,k}(t-\tau,\, t]$ | tokens of bucket $k$ that agent $a$ consumed in the last $\tau$ |
| $\hat{w}_k$ | the fitted cost of one token of bucket $k$, in percent per token |

In words: take that agent's tokens from the last ten minutes, split them into
buckets, multiply each by its weight, add up, and scale to an hour.

**$\tau$ is not $W$.** $W$ is the vendor's quota window — a property of your plan.
$\tau$ is how far back *we* look to compute a rate — a property of our
measurement. They are unrelated, and conflating them is the easiest mistake to
make here.

Both rates come out in percentage points per hour, which is the point — they are
directly comparable to each other and to every alarm threshold.

## The free consistency check

The intuition first, because it is almost right and the "almost" matters: *over
some interval, the per-agent burns should add up to the overall change the
vendor reported.* That is the idea — with one correction.

The vendor's $\Delta u$ is a **net** number: consumption pushed it up, and old
tokens aging out of the back of the rolling window pulled it down. The agents'
burns only describe the *consumption* side — no agent is responsible for the
aging-out. Compare the two directly and they disagree by exactly the aged-out
amount, worst in the quiet hours after a burst, when $\Delta u$ is negative
while agents are genuinely still spending. (An earlier draft of this document
made precisely this mistake.)

So move the aging-out to the other side of the equation. Over the interval
$(t_{n-1}, t_n]$, the **gross** consumption implied by the vendor is the
reported change plus what aged out, priced through the fitted weights:

$$\underbrace{\Delta u_n + \sum_{k} \hat{w}_k \, \text{out}_{n,k}}_{\text{gross burn, per the vendor}} \;\approx\; \underbrace{\sum_{a \in A} \sum_{k} \hat{w}_k \, c_{a,k}(t_{n-1},\, t_n]}_{\text{gross burn, summed over agents}}$$

The right side decomposes **exactly** by agent, because every token in the
transcripts belongs to exactly one session — attribution is bookkeeping, not
estimation. The left side rests on the vendor's report. The consistency residual
is the gap:

$$\varepsilon_n = \left\lvert\, \Delta u_n + \sum_k \hat{w}_k \, \text{out}_{n,k} - \sum_{a} \sum_k \hat{w}_k \, c_{a,k}(t_{n-1}, t_n] \,\right\rvert$$

What each failure smells like:

* **Wrong weights** — $\varepsilon$ tracks the fit residual $e_n$; both sides
  lean on $\hat{\mathbf{w}}$, so a bad fit moves them together.
* **Missed consumption** — the vendor side reads persistently *higher* than the
  agent side: something is burning quota that Adjent is not watching. Another
  device on the same account, a mobile session, a backend with no adapter. This
  is the genuinely valuable alarm, and no amount of local bookkeeping can produce
  it — only the comparison against the vendor can.
* **Double-counted consumption** — the agent side reads persistently higher:
  most likely a transcript parsed twice or a subagent counted at both levels.

The per-poll $\varepsilon_n$ is noisy (one poll spans a whole-percent-rounded
$\Delta u$), so the UI consumes it as an EWMA, exactly like the burn rate. A
small, stable $\bar{\varepsilon}$ is what decays $\lambda$ — the data has
earned the right to override the prior — and it costs nothing to compute and
needs no ground truth, which is rare enough to be worth building around.

### Two residuals, doing two different jobs

The document uses two, and they are not interchangeable:

| | Definition | What it tests |
| --- | --- | --- |
| $e_n$ — **fit residual** | $\Delta u_n - \mathbf{x}_n^\top \hat{\mathbf{w}}$ | whether the **pricing** is right. One signed number per poll, internal to the fit. Because it is signed and per-poll, it can be stratified to find *which* assumption broke. |
| $\varepsilon_n$ — **consistency residual** | gross burn per the vendor vs. gross burn summed over agents (see above) | whether the **coverage and attribution** are right as well. |

The second is worth having because of a blind spot in the first. The fit only
ever sees account-level totals, so if Adjent credited a subagent's tokens to the
wrong parent, every $e_n$ would stay perfectly small — the account arithmetic
still balances. $\varepsilon$ compares a per-agent reconstruction against a
measurement the model played no part in, so mis-attribution has somewhere to
show up.

They are not statistically independent; both ultimately compare measured
utilization against the model. But they fail differently, and the per-agent
numbers are exactly what mis-attribution would ruin — so it is the error worth
spending a second check on.

Derived numbers are always shown with `≈`. The hero number never is, because it
is measured.
