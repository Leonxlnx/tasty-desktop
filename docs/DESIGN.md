# Design System

Kimi Code Desktop uses a quiet, Windows-native interface designed for long coding sessions.

## Principles

- Keep the active conversation visually dominant.
- Treat the sidebar, conversation, and work panel as one connected workspace.
- Use neutral charcoal surfaces instead of gradients or tinted shadows.
- Reserve blue for focus, selection, links, and live state.
- Keep controls compact without reducing keyboard or pointer hit targets.
- Use motion only to explain state changes.

## Color

All interface colors come from `apps/web/src/styles/tokens.css`.

- Canvas and sidebar use neutral near-black values.
- Raised surfaces use two charcoal steps.
- Primary text is soft white.
- Secondary and disabled text use neutral grays.
- Success, warning, and danger colors appear only when the corresponding state is real.

The interface does not use decorative gradients, neon glows, or permanent backdrop blur in scrolling surfaces.

## Typography

The default stack uses Segoe UI Variable and Aptos with system fallbacks. Monospace type is limited to paths, commands, methods, diffs, and terminal output.

Hierarchy comes from size, weight, and spacing. Settings allow users to change the base font, font size, and density without breaking layout.

## Shape and spacing

The base spacing unit is 4 px. Common gaps are 8, 12, 16, 24, and 32 px.

- Controls use a 6 px radius.
- Cards use a 10 px radius.
- The composer uses a 20 px radius.
- Dialogs use a 14 px radius.
- Borders are 1 px and low contrast.
- Shadows are reserved for modal separation.
- Pills are reserved for status, key hints, and runtime modes.

## Layout

The desktop has three functional zones:

1. Project and chat navigation
2. Conversation
3. Optional work panel

The left sidebar collapses to an icon rail. The right work panel becomes a drawer at narrow widths. Users can resize and reposition both panels.

## Interaction

- Chat messages use whitespace and role alignment rather than repeated cards.
- Thinking and tool activity are collapsed by default.
- Tool calls use one bordered surface with status and bounded details.
- Plans use a vertical checklist with one clear active state.
- Approval requests interrupt the flow with explicit actions.
- Diffs use stable line numbers and restrained red and green backgrounds.
- Empty, loading, offline, and error states remain concise and functional.

Transitions use transform and opacity, normally between 120 and 180 ms. Background animation pauses when the window is hidden. `prefers-reduced-motion` removes travel and looping indicators.

## Accessibility

- Every action is reachable by keyboard.
- Focus is visible and never communicated by color alone.
- Controls have accessible names.
- Interactive targets are at least 32 px.
- Body text and interactive labels target WCAG AA contrast.
- Hover-only actions remain reachable through focus and context menus.

## Voice

Product copy is calm, direct, and technical. Use short labels such as **Reconnect**, **Allow once**, and **Revert turn**. Avoid emoji, invented metrics, and marketing language in application chrome.
