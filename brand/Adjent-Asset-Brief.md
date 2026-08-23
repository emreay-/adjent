# Adjent — image asset brief

Self-contained brief for whoever produces the artwork. You do not need to know
the codebase; everything the assets must satisfy is stated here.

**Product.** Adjent is a tray-resident desktop app (Windows and Linux) that
watches local AI coding agents and reports how much of your model quota is
burned. Its permanent, always-visible surface is a **16×16 icon in the Windows
notification area** — that constraint drives most of what follows.

**Agreed direction.** A robot head with a gauge across its forehead. Two
artefacts: the product logo, and a tray icon set in three styles × four states.

---

## 0. Revision 2 — read this first

The first artwork round (1536×1024 sheet, three styles × four states) is close
on the logo and **not yet usable for the tray**. Two problems, both measured
from that sheet rather than eyeballed. Everything not mentioned here is
unchanged.

### 0.1 The verdict colour must cover the whole icon

Measured share of visible pixels carrying any verdict colour, and the icon's
mean hue per state:

| Style | idle | on-pace | ahead | over |
| --- | --- | --- | --- | --- |
| Robot | 16.8% · 203° | 22.0% · 181° | 17.4% · 180° | 20.5% · 191° |
| Gauge ring | 13.7% · 207° | 19.5% · 140° | 22.7% · 40° | 25.1% · 16° |
| A-mark | 8.2% · 206° | 14.0% · 145° | 14.9% · 70° | 14.7% · 33° |

The robot line is the important one: **its mean hue is ~180–203° in all four
states** — cyan. The eyes and the white shell dominate every state, and the
verdict lives in an antenna ball and two or three gauge segments. At 16px that
is a handful of pixels, and the four states are the same icon.

**Requirement.** At tray sizes the verdict colour is the icon's *field*, not an
accent on it: **≥ 60% of opaque pixels carry the verdict hue**, and the icon's
mean hue must move by **≥ 60° from `on-pace` to `ahead`**. (`ahead` → `over` is
governed by §0.3 instead — 60° is not available between orange and red, which is
why that pair also changes form.)

Concretely, for each style:

- **Robot** — the verdict colours the head shell. Visor stays `#131A22`, eyes
  stay `#6FEFEF`; those are the character and must not change. Everything else
  takes the verdict hue.
- **Gauge ring** — the ring body takes the verdict hue.
- **A-mark** — the A itself takes the verdict hue. In the current sheet the A is
  dark navy, which vanishes on a dark taskbar.

### 0.2 The multi-colour gauge track has to go at tray sizes

Every state in the sheet contains green *and* amber *and* red segments, because
the gauge track is drawn in full each time. That is why the coloured pixels have
a hue spread of 0.22–0.73 (0 = one pure hue, 1 = evenly spread): there is no
single colour signal to read. It is correct on the large logo and wrong on a
16px glyph.

**Requirement.** At 24px and below, the gauge track is a single hue — the
current verdict. Keep the full green→red track on the logo only.

### 0.3 Ahead and over must separate

Measured hue separation between `ahead` and `over`: **robot 11°, ring 24°,
A-mark 37°.** For scale, green→red is about 120°. None of these is reliable at
16px, and orange-vs-red is the single worst pair for the most common form of
colour-blindness — a protanope sees these two as the same colour.

**Requirement.** Ahead is orange, over is red, and they differ in **three** ways,
not one:

| | `ahead` | `over` |
| --- | --- | --- |
| Fill | `#FF8F00` | `#B3181F` |
| Hue | 34° | 357° |
| Form | Coloured glyph, transparent ground | **Inverted** — light glyph on a solid red field |

- Hue separation ≥ 30°.
- Contrast ratio between the two fills ≥ 2.5:1 — the recommended pair is 3.0:1,
  so `over` reads as darker even in greyscale.
- The **inversion** is what actually carries it. `over` is the only state drawn
  as a filled plate with the glyph knocked out of it. That survives greyscale,
  colour-blindness, and 16px, and it correctly makes the worst state the
  loudest thing in the tray.

Deliver a greyscale proof of the four states per style: if `ahead` and `over`
are indistinguishable with colour removed, the set is not finished.

---

## 0A. Round 2 assessment — three things left

Round 2 fixed the main faults. Measured, per style:

| | coverage `on-pace` / `ahead` / `over` | mean hue | `ahead`→`over` |
| --- | --- | --- | --- |
| Robot | 50% / 57% / 72% | 123° · 37° · 359° | 38° |
| Gauge ring | 27% / 55% / 76% | 120° · 32° · 360° | 33° |
| A-mark | 16% / 64% / 79% | 138° · 33° · 359° | 34° |

**Fixed:** coverage is up from 8–25% to 50–79%; the hues are now clean and
single rather than a green→red ramp; `on-pace`→`ahead` moves 86–105°; and the
inversion is in place on the robot and the ring, which is what carries the
`ahead`/`over` distinction. That part is done — don't revisit it.

Three items remain.

### A. `on-pace` is under-coloured

Coverage is **50% (robot), 27% (ring), 16% (A-mark)** against the 60% bar — the
only state still failing §0.1. The ring keeps a large dark centre, and the
A-mark's A stays dark navy with only the gauge picking up green.

**Fix.** Give `on-pace` the same field treatment `ahead` already has: the head,
the ring body and the A itself take the verdict hue. Whatever was done to make
`ahead` work, do it to `on-pace`.

### B. The A-mark's `ahead` and `over` are identical in greyscale

Mean luminance: **97 vs 93** — a 4-point gap. On the robot and the ring the
inversion opens a 31–32 point gap (87→118 and 79→111), which is why they pass.
The A-mark doesn't invert: the A stays a solid colour in both states and only
the gauge arc flips.

**Fix.** At `over` the A becomes the *light* element on a solid red field, as
the robot and ring already do. Same rule, applied to all three styles.

### C. The greyscale proof isn't greyscale

Measured across the proof strip: **mean saturation 10.5%, peak 77% at hue 196°.**
The cyan eyes were never desaturated, so the proof cannot demonstrate the thing
it exists to demonstrate.

**Fix.** Desaturate every layer, eyes included, and re-export. A true proof has
0% saturation everywhere.

### Correction to this brief

§0.1 originally asked for a ≥60° mean-hue move between `on-pace`, `ahead` *and*
`over`. That is not achievable between orange and red and contradicted §0.3.
§0.1 now applies to `on-pace`→`ahead` only; §0.3 governs `ahead`→`over`. The
round-2 artwork was right and the brief was wrong.

---

## 1. Division of work

| Who | What |
| --- | --- |
| **Image work (this brief)** | Logo master; tray icon masters at large size; per-state colour variants |
| **Stays in the repo** | 16×16 pixel-grid cuts, `.ico` packing, RGBA buffer rendering, the style-picker setting |

The 16px cuts are hand-authored against the pixel grid and are **not** expected
from this brief. Deliver clean, large, structured masters and they can be cut
from those. If you also want to supply 16×16 art, section 6 says how.

---

## 2. What already exists, and why it can't be used

Two screenshots were supplied. Both are unusable as source, for reasons that are
worth stating so they aren't reproduced:

**Logo screenshot — 310×237, 32bpp, no usable alpha.**
The dark navy ground (`#102030`) is baked in and is the single most common
colour in the file (~22,000 of ~73,000 pixels). The character has a soft drop
shadow and glossy edges that blend continuously into that ground, so it cannot
be keyed out — any cut-out leaves a dark halo. 310px is also far below the
512–1024 an application icon needs.

**Tray sheet — 1127×291.**
This is a screenshot of a *comparison page*: title, pills, labels, drop shadows,
background gradient. The icons labelled "16×16" are upscaled previews, not 16px
art. There is no 16×16 source anywhere in the file to extract.

**Rule for everything below: deliver artwork, not pictures of artwork.**

---

## 3. Deliverable A — product logo

| Requirement | Value |
| --- | --- |
| Primary format | **SVG**, vector only |
| Fallback format | PNG, **1024×1024**, if vector is impossible |
| Canvas | Square, `viewBox="0 0 1024 1024"` (or any square) |
| Background | **Fully transparent.** No ground, no plate, no tile, no shadow |
| Colour space | sRGB |
| Artwork extent | Occupies 86–92% of the canvas, optically centred |

**Structure (this matters more than it looks).** Group and `id` the parts so the
gauge can be recoloured and animated in code:

```
#head  #antenna  #pods  #visor  #eyes
#gauge-track  #gauge-fill  #gauge-needle
```

`#gauge-fill` and `#gauge-needle` must be independently recolourable and, ideally,
independently rotatable/trimmable — the shipped app drives them from live data.

**Must not contain:** `<filter>`, `<image>`, `<text>`, `<foreignObject>`,
external `href`s, CSS classes that depend on a stylesheet, or embedded rasters.
Convert strokes to filled outlines. Blur, bevel and gloss are filter effects and
will not survive; see section 7.

---

## 4. Deliverable B — tray icon masters

Three styles, four states each — **12 artworks**.

**Styles.** `gauge` (gauge ring with needle) · `robot` (robot head) ·
`mark` (chevron mark under a gauge arc)

**States.** `on-pace` · `ahead` · `over` · `idle`

| Requirement | Value |
| --- | --- |
| Format | SVG per artwork, square viewBox |
| Master size | Design at 256×256 or larger |
| Background | Transparent, no shadow, no plate |
| Alpha | Binary at the silhouette edge where possible |
| Naming | `tray/{style}/{state}.svg` — e.g. `tray/robot/ahead.svg` |

**The states differ by colour, not by shape** — same geometry throughout a
style, so switching states never makes the glyph jump.

---

## 5. Colour

Sampled from the supplied artwork:

| Role | Hex |
| --- | --- |
| Body / shell | `#E8EEF2` |
| Shell edge, pods | `#A6B4C0` |
| Visor | `#131A22` |
| Eyes | `#6FEFEF` |

The app already ships these verdict colours, and they are referenced across the
UI, the docs and the alarm copy:

| State | Use this | App ships today | First artwork round |
| --- | --- | --- | --- |
| `on-pace` | `#0CA30C` | `#0CA30C` | `#4FD06A` |
| `ahead` | **`#FF8F00`** | `#FAB219` | `#E9E24F` |
| `over` | **`#B3181F`** | `#D03B3B` | `#F02F30` |
| `idle` | `#8693A0` | `#8693A0` | — |

`ahead` and `over` move deliberately (see §0.3): the shipped amber is too close
to yellow to read as a warning at 16px, and the shipped red is too light to
separate from it. The app's tokens will be updated to match, so **use the
"Use this" column** — these are now the single source of truth, not the app.

Everything else stays on the app's values; the tray icon and the in-app verdict
chip must never be different greens.

---

## 6. Sizes and legibility

Where these end up, in device pixels:

- **Windows tray** — logical 16px, rendered at 16 / 32 / 48 for scale factors 1×, 2×, 3×
- **Linux panel** — logical 22px, rendered at 22 / 44 / 66
- **Application icon** — 16, 24, 32, 48, 64, 128, 256 packed into `.ico`; 512 PNG for Linux
- **Panel header, in-app** — 13–16px

Two constraints follow, and they are the ones most often missed:

**It must read on light and dark.** Windows taskbars are near-black in dark mode
and near-white in light mode. Artwork that is only near-white disappears on one;
only near-black disappears on the other. Keep a mid-tone edge, or a coloured
element that holds on both. Test against `#1F1F1F` and `#EFEFEF`.

**Nothing below 24px may rely on:** gradients, drop shadows, outer glows,
strokes thinner than 1 device pixel, or any detail smaller than ~2×2 px. A
feature that occupies one pixel row at 16px is noise, not detail — this is
already known to break the forehead gauge strip on the robot style.

**Optional, and genuinely useful:** hand-pixelled 16×16 PNGs per style/state,
authored at exactly 16×16 with **no antialiasing and no partial alpha** (every
pixel either fully opaque or fully transparent), max ~4 distinct colours.
Deliver as `tray/{style}/{state}-16.png`. If you cannot guarantee those
properties, don't supply them — a downscaled 256px master is worse than nothing
and will be redrawn anyway.

---

## 7. The gloss question

The reference logo is a rendered 3D look: bevels, specular highlights, soft
shadow. Flat vector cannot carry that, and neither can a 16px tray icon or a
one-colour print.

Deliver **both** where possible:

1. **Flat vector master** (section 3) — the working logo. Scales everywhere, recolours, prints.
2. **Rendered hero PNG**, 1024×1024, transparent, no cast shadow — for the website, README and store listing only.

They must be the same character with the same proportions, so that seeing one
after the other doesn't read as two different mascots.

---

## 8. Acceptance criteria

Each item is checkable without opinion:

- [ ] Corner pixels have alpha 0; no baked background anywhere
- [ ] Canvas is square; stated dimensions exact
- [ ] SVG contains no `<filter>`, `<image>`, `<text>`, `<foreignObject>` or external reference
- [ ] Logo groups are present and named as in section 3
- [ ] 12 tray artworks delivered, geometry identical within each style
- [ ] Verdict colours match section 5, and which set was used is stated
- [ ] Every artwork legible against both `#1F1F1F` and `#EFEFEF`
- [ ] Any supplied 16×16 PNG has binary alpha and no antialiasing
- [ ] No text or wordmark inside any mark
- [ ] **≥ 60% of each tray icon's opaque pixels carry the verdict hue** (§0.1)
- [ ] **Mean hue moves ≥ 60°** between `on-pace`, `ahead` and `over`
- [ ] **At ≤24px the gauge track is a single hue**, not a green→red ramp (§0.2)
- [ ] **`over` is drawn inverted** — light glyph on a solid red field (§0.3)
- [ ] **Greyscale proof supplied**, and `ahead` vs `over` still tell apart in it

## 9. Do not deliver

Screenshots · composited comparison sheets · anything with labels or captions
baked in · JPEG · art on a background · art with a drop shadow · downscaled
rasters standing in for small sizes · a single sheet containing multiple icons

## 10. Also worth sending

The editable source (Figma link, `.ai`, `.fig`, `.pdf`), and the tool and prompt
used — more states and sizes will be needed later, and matching them by hand is
expensive.
