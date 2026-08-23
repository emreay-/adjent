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

| State | App value | Value in the supplied art |
| --- | --- | --- |
| `on-pace` | `#0CA30C` | `#4FD06A` |
| `ahead` | `#FAB219` | `#E9E24F` |
| `over` | `#D03B3B` | `#F02F30` |
| `idle` | `#8693A0` | — |

**This is a decision, not a detail.** Either the artwork adopts the app values,
or the app adopts the artwork's — but the tray icon and the in-app verdict chip
must not be different greens. **Default assumption: use the app values** unless
told otherwise. State which you used.

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

## 9. Do not deliver

Screenshots · composited comparison sheets · anything with labels or captions
baked in · JPEG · art on a background · art with a drop shadow · downscaled
rasters standing in for small sizes · a single sheet containing multiple icons

## 10. Also worth sending

The editable source (Figma link, `.ai`, `.fig`, `.pdf`), and the tool and prompt
used — more states and sizes will be needed later, and matching them by hand is
expensive.
