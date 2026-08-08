# Design System

Kimi Code Desktop uses a quiet, Windows-native interface for long coding sessions. The default graphite theme reads as one continuous workspace, not a stack of disconnected cards.

## Principles

- Keep the active conversation visually dominant.
- Treat navigation, conversation, and the work panel as one connected workspace.
- Use neutral charcoal surfaces instead of tinted shadows or decorative gradients.
- Reserve accent color for focus, selection, links, and live state.
- Keep controls compact while preserving keyboard and pointer hit targets.
- Use motion to explain a state change, not to decorate idle chrome.

## Product identity

The source image for native assets is `apps/desktop/kimi-icon-source.png`. The renderer uses `apps/web/public/kimi-logo.png`.

Kimi names and artwork identify compatibility with Kimi Code CLI. They do not imply affiliation with Moonshot AI and are not covered by the repository's MIT License.

## Color and type

Interface colors come from `apps/web/src/styles/tokens.css`.

- Canvas, chrome, and navigation use neutral near-black and graphite values without a blue cast.
- Raised surfaces appear only where elevation communicates interaction.
- Primary text is soft white, while secondary and disabled text use readable neutral grays.
- Success, warning, and danger colors appear only for real states.
- Decorative glow, heavy blur, and continuous GPU effects are not part of normal chrome.

The default type stack uses Segoe UI Variable and Aptos with system fallbacks. Monospace type is limited to paths, commands, methods, diffs, and terminal output. Settings can change the base font, font size, and density without breaking layout.

## Shape and spacing

The base spacing unit is 4 px. Common gaps are 8, 12, 16, 24, and 32 px.

- Controls use a 5 to 8 px radius.
- Bounded content uses a 10 to 14 px radius.
- The composer uses a larger continuous radius.
- Dialogs use a 14 px radius.
- Borders are 1 px and low contrast.
- Shadows are reserved for modal separation.
- Pills are reserved for status, key hints, and runtime modes.

## Layout

The desktop has three functional zones separated by single-pixel dividers:

1. Project and chat navigation
2. Conversation
3. Optional work panel

The left sidebar collapses to an icon rail. Project and chat selection uses a light overlay, not a dark filled pill. Rows remain compact, and spacing between project groups does not create empty vertical blocks.

The right work panel is a grid column, not an overlay on the conversation or composer. It becomes a drawer only at narrow widths. Users can resize and reposition panels.

The composer keeps writing space visually dominant and uses one send-or-stop action. Queued prompts attach above the input within the same surface. Model, reasoning, permission, context, attachment, and command controls remain readable without competing with the prompt.

## Interaction and motion

- Chat messages use whitespace and role alignment instead of repeated cards.
- Thinking and tool activity are collapsed by default.
- Tool rows show a compact status line and reveal bounded details on request.
- Approval requests interrupt the flow with explicit actions.
- Diffs use stable line numbers and restrained red and green backgrounds.
- Opening a chat starts at the latest message.
- Live output follows only while the reader remains near the bottom.
- Scrolling upward detaches follow mode and reveals a **Jump to latest** action.

Frequent keyboard actions do not animate. Pointer feedback uses short opacity or transform transitions, normally under 200 ms. Menus originate from their trigger. Background animation pauses when the window is hidden. `prefers-reduced-motion` removes travel and looping indicators.

## Accessibility

- Every action is reachable by keyboard.
- Focus is visible and never communicated by color alone.
- Controls have accessible names.
- Interactive targets are at least 32 px.
- Body text and interactive labels target WCAG AA contrast.
- Hover-only actions remain reachable through focus and context menus.

## Voice

Product copy is calm, direct, and technical. Use short labels such as **Reconnect**, **Allow once**, and **Revert turn**. Avoid emoji, invented metrics, and marketing language in application chrome.
