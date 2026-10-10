# Design

Secbot has two surfaces: the `secbot` command line (now) and the app on phone, tablet, and desktop web (the primary surface, once it ships). Both follow one quiet instrument-panel style, taken from two reference images the owner chose. The command line renders it in plain text. The app renders it with the tokens below.

## Colors
App only. The command line prints no color.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--ground` | `oklch(0.15 0.006 50)` | `oklch(0.952 0.007 62)` | Page background; warm-tinted, never `#000` or `#fff` |
| `--panel` | `oklch(0.195 0.008 50)` | `oklch(0.985 0.005 70)` | Cards, sheets, dialogs |
| `--panel-2` | `oklch(0.235 0.009 50)` | `oklch(0.935 0.008 62)` | Raised controls, the person's chat bubbles, the active nav item |
| `--rule` | `oklch(0.285 0.009 50)` | `oklch(0.875 0.01 60)` | Hairline borders and table rules |
| `--text` | `oklch(0.93 0.008 70)` | `oklch(0.21 0.01 50)` | Primary text and filled data dots |
| `--muted` | `oklch(0.64 0.012 60)` | `oklch(0.47 0.014 55)` | Labels and secondary text |
| `--faint` | `oklch(0.45 0.01 55)` | `oklch(0.66 0.012 58)` | Brackets, times, redaction dots; never body text |
| `--off` | `oklch(0.29 0.009 50)` | `oklch(0.865 0.01 60)` | Empty data dots |
| `--heat-1` | `oklch(0.62 0.21 32)` | `oklch(0.55 0.20 32)` | Red: refused, limit reached, prohibit |
| `--heat-2` | `oklch(0.71 0.18 48)` | `oklch(0.63 0.17 46)` | Orange: the one accent — the primary action, held, ask first, the hot tip of a ring or meter |
| `--heat-3` | `oklch(0.80 0.15 72)` | `oklch(0.70 0.15 68)` | Amber: 80% of a limit, would block, waiting jobs |
| `--heat-4` | `oklch(0.90 0.14 100)` | `oklch(0.80 0.14 95)` | Yellow: the lowest band in stacked charts only, never text |

Ambient light: one soft radial wash of `--heat-2` hue from the top-right corner of the page (dark: 26% alpha, light: 60% alpha of a pale peach), and a fainter one from the bottom-left. Cards sit on it; text never sits on the strongest part of it.

Strategy: Restrained. The orange accent covers at most 10% of a screen and marks the primary action or a state. Red and amber appear only with a state word beside them. Color is never the only sign of a state.

## Typography
Two voices, one family:
- **Geist** (sans) for people's words and the interface: titles, the chat messages, buttons, body text, and large numbers. Titles are sentence case ("Activity"), weight 600, letter-spacing −0.03em. Large numbers are weight 500 with tabular numerals.
- **Geist Mono** for machine data: tool names, arguments, rule matches, verdict tags, `[ LABEL: value ]` fields, the event lines in chat, tables, and the small uppercase labels.
- **Labels:** Geist Mono, uppercase, letter-spacing 0.1em, `--muted`, at least 12px (0.75rem) in the build.
- **Scale:** fixed rem, ratio 1.2: 0.75 (labels), 0.875 (secondary), 1 (body, chat messages), 1.2, 1.44, 1.75 (titles on phone), 2.1 (titles on tablet and desktop), 2.5–3 (hero numbers).
- No dot-matrix or display face for text or icons.

## Components
No component library yet. The patterns, shared by both surfaces:

- **Bracket field** — `[ LABEL: value ]` in Geist Mono: brackets `--faint`, label `--muted`, value `--text` bold. In the command line: `[ month: $11.52 / $25.00 ]`.
- **Verdict tag** — `[ ■ WORD ]`: a small square in the state color, then the word. Words: ALLOWED, HELD, REFUSED, WOULD BLOCK, LAPSED, DONE, RUNNING, WAITING, PERMIT, ASK FIRST, PROHIBIT, SHADOW.
- **Dot ring** — the usage indicator and the lapse countdown: 28–56 dots on a circle; filled dots in `--text`, the last two filled dots in `--heat-2` (the hot tip); at 80% and over the limit, the whole filled run takes amber or red. The value sits in the centre in Geist.
- **Meter** — a run of round dots, filled `--text` with an orange tip, empty `--off`. In the command line: `#` filled and `.` empty, 10 cells in the usage line, 20 in `secbot cost`.
- **Hour strip** — 24 small squares for today's hours, `[`…`]`; lit in the state color where a call was refused, held, or would block.
- **Waveform** — columns of dots, one per time slot, height by call count; refused, held, and would-block slots lit in their state color.
- **Heat chart** — spend by hour of day, stacked by role, thin rounded bars: lead `--heat-1` on top, research `--heat-2`, household `--heat-3`, health `--heat-4` at the base.
- **Card** — `--panel`, 1px `--rule` border, 16px radius, soft drop shadow; a numbered Geist Mono label (`01  USAGE`) top-left.
- **Held-call sheet** — bottom sheet on phone, centred dialog on tablet and desktop: countdown ring, `[ ■ HELD #1 ]`, a one-line title, agent, tool, redacted arguments in a dashed box, "why held", then three full-width buttons: Allow once (filled orange), Allow always (shows the rule it adds), Deny. No button has default focus.
- **Icons** — thin line icons, 1.6px stroke, 22px.

## Design Tokens
The tokens above are the source until the app adds a token file. The command line has no tokens: it uses the text patterns in Components.

## Elevation and Shadows
Cards and sheets carry one soft drop shadow (dark: `0 24px 48px -28px` near-black; light: `0 24px 48px -30px` warm grey) over a 1px hairline border. Dialogs carry a deeper shadow over a dimmed, lightly blurred page. No glow on buttons or text; only state dots and ring tips carry a faint 5px glow. The command line has no shadows.

## Notes
- Command-line output is plain UTF-8 text with ASCII framing (`[`, `]`, `#`, `.`, `-`, `->`). It has no color, no box-drawing characters, no spinners, and no terminal control codes, so it reads the same in a log file and in a test with no TTY.
- The app ships a dark theme and a light theme from its first release; every screen is designed in both.
- App viewports: phone (390x844), tablet (820x1180), and desktop web (1440x900).
- Touch targets are at least 44x44px; desktop-only pointer controls at least 32x32px.
- Motion (app): 150–250 ms state changes; the usage ring animates only when spend changes, never on a loop.
