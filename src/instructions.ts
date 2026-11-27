/**
 * Short, always-loaded essentials. The full guidance is NOT duplicated here: its single
 * source is skills/Clickr/SKILL.md, which the server serves as the MCP resource
 * skill://clickr/SKILL.md and the MCP prompt `clickr-skill` (see skill.ts), and which
 * `clickr install` copies to ~/.claude/skills/Clickr for Claude Code.
 */
export const INSTRUCTIONS = `clickr drives this Mac's screen, mouse and keyboard. FULL GUIDANCE: read the MCP resource skill://clickr/SKILL.md (or fetch the prompt "clickr-skill") before first use; the essentials follow for clients without resource support.

- Actuating tools (click, move_mouse, drag, scroll, type_text, press_key, activate_app, set_window_bounds, set_clipboard) work only after the operator hands over control ("your controls" or \`clickr controls you\`). Never grant yourself control. Each actuating call needs a \`step\`: one plain sentence saying what and why. Read-only tools always work.
- Prefer a real API/CLI, then AppleScript dictionaries, then a browser extension; clickr seizes the user's pointer and keyboard, so tell the user first and ask them to keep hands off.
- Coordinates are global points (top-left of main display, +y down; other displays may be negative). Prefer find_elements/read_text (text) over screenshots; pass webContent:true in web pages and Electron apps.
- Coordinates go stale (reflow, display change, occlusion): verify every state-changing click via its hitElement.`;
