# Product

## Register
product

## Users
Two adults in one household: the owner, who runs the system and holds the operator key, and one other member. Both use Secbot as a general personal agent between other tasks, mostly from the phone app (wave 3 onward) and, until then, from the `secbot` command line. The owner is technical; the other member uses the agent, not its internals.

## Brand Personality
- **Instrument panel** — every view reads like a gauge: a label, a value, and a state, framed and aligned.
- **Exact** — numbers, names, and reasons are shown in full; nothing is rounded into a vague word.
- **Quiet** — the agent reports state; it does not celebrate or alarm.
- **Warm** — one warm accent ramp (red to orange to amber to yellow) on a dark, warm-tinted ground, never a cold blue.
- **Household** — the words are for two people at home, not for a security team or an enterprise.

## Tone
Calm and plain, like a trusted instrument: short factual lines, the state first, then the reason. An approval prompt or a limit notice is serious but never alarming. It must not feel like a security product (shields, threat levels, sirens), an enterprise admin console, or a playful chatbot.

## Positive References
- Resource overview panel (reference image 1, `.ai/workflows/safety-core/design/source/reference/ref-1-resource-overview.jpg`) — the `[ label: value ]` bracket frame, the segmented display title, the stacked warm bar chart, and the hairline-ruled breakdown box.
- DeerFlow AIoT dashboard (reference image 2, `.ai/workflows/safety-core/design/source/reference/ref-2-deerflow-dashboard.jpg`) — dot-matrix numerals and figures, small uppercase labels, one orange accent for state, and quiet near-black cards.
- The Claude Code permission prompt — a held tool call with its arguments and a short allow-once, allow-always, deny choice.

## Anti-references
- Security-product alarm — red shields, threat levels, warning sirens. Secbot is not a security product.
- Enterprise admin console — dense settings trees and compliance language.
- Decorated terminal UI — color, box drawing, spinners, and control codes that break in a log file or a test with no TTY.

## Strategic Principles
An approval must be answerable in seconds and must never be answered by accident. Cost is always visible wherever a person talks to the agents, and every refusal names the rule or layer that made it and why. Every command-line view maps one-to-one to a later app screen on the same cell routes, so the app adds presentation, not decisions. The command line carries the instrument-panel style in plain text only; color and dot-matrix type belong to the app.
