# Design notes

No UI kit or template was used. The look is a small hand-written system in `public/styles.css`, chosen to read like an election-night briefing rather than a SaaS dashboard. The 21st.dev CLI was consulted for reference only (the "Editorial" theme and a segmented-control pattern); its components are React and nothing from it is in the code.

## Type

| Role | Face | Notes |
|---|---|---|
| Nameplate, section titles, figures, tables | **Archivo** (Google Fonts, variable) | `font-stretch` 104–112% on headings and the nameplate gives the wide, broadcast-board feel; weight 700–800 for display, 600 for table emphasis. Tabular numerals everywhere (`font-variant-numeric: tabular-nums`). |
| Running text, notes, footers, "what moved" list | **Source Serif 4** (Google Fonts, variable, optical sizes) | Serif body text is what keeps it from looking like every sans-on-sans dashboard. Line length capped at about 68 characters. |

Import: `@import url("https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400..600;1,8..60,400&display=swap");`

## Color

Chrome is neutral so that data colors carry all the meaning.

| Token | Value | Use |
|---|---|---|
| `--paper` | `#ffffff` | page |
| `--ink` | `#22252a` | text, rules under section titles, active controls (not pure black) |
| `--ink-2` / `--ink-3` | `#5d626b` / `#8a8f98` | secondary and muted text |
| `--rule` / `--rule-soft` | `#d9dce1` / `#eceef1` | table and figure rules |
| `--wash` | `#f4f5f7` | empty portion of split bars |
| Ratings scale | `--d4 #1e3a8a`, `--d3 #2563eb`, `--d2 #60a5fa`, `--d1 #bfdbfe`, `--toss #8b8b8b`, `--r1 #fecaca`, `--r2 #f87171`, `--r3 #c01818`, `--r4 #6b1010` | Safe D → Tossup → Safe R. Adjacent steps were checked with a color-vision-deficiency validator (OKLab ΔE ≥ 15 for normal vision, ≥ 8 under protan/deutan). |
| Deltas | `--to-d #1d4ed8`, `--to-r #b91c1c` | a change is colored by the party it moves toward, never "good/bad" green/red |

Probability maps use a diverging ramp from `--r3` through a near-neutral `#e9e9e6` to `--d3`; 2024-margin maps use the same idea with `--r4`/`--d4` at the ends.

## Layout rules

- No cards. Sections are separated by whitespace (56px) and a 1px ink rule under each title.
- Figures live in a **ruled strip**: big number (Archivo 700, 30px) over a sentence-case label, divided by vertical rules. The primary figure gets an ink left border instead of a different color.
- The hero is a **board** of split bars: one two-color bar per marquee race, 12px tall, 2px radius, D share from the left.
- Tables: sentence-case headers, 1px row rules, numbers right-aligned and tabular, small category "pills" (3px radius) only for ratings.
- Navigation: a sticky tab bar with a 2px ink baseline and a 3px underline on the active tab; panels are hash-routed.
- Controls: one segmented control (ink fill on the active segment) for the probability source; small outlined buttons for map modes and zoom.
- Copy: sentence case everywhere, no all-caps labels, no middle-dot joiners, no arrows in labels. Active voice, plain words.
- Motion: none on load; only color transitions on controls, and only when `prefers-reduced-motion` allows.

## Things deliberately avoided

Cream backgrounds with a terracotta accent, dark mode with one neon accent, identical rounded cards with soft shadows, uppercase tracked eyebrow labels, monospace data labels, gradient washes, and emoji. Those are the common tells of generated interfaces.
