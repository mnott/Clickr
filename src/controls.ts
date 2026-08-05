import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Control-handover state for clickr's actuating tools.
 *
 * This is a "flight instructor" pattern: the operator (the person at the keyboard) and
 * the agent (the model) share one set of controls, and only one of them holds it at a
 * time. Actuating tools -- the ones that move the mouse, type, or otherwise touch the
 * real machine -- are gated on the operator explicitly handing control to the agent by
 * saying so out loud ("your controls") or running `clickr controls you`. Read-only
 * tools are never gated: looking is always allowed, touching is not.
 *
 * This is a clarity mechanism, not a security boundary -- anyone with shell access can
 * already run `clickr controls you` directly. Its job is to stop the agent from acting
 * on the operator's machine when the operator hasn't said it may, not to defend against
 * a hostile actor with local access.
 */

export type Holder = "user" | "agent";

export interface ControlsState {
  holder: Holder;
  since: string;
  until?: string;
  note?: string;
}

/** How long a grant to the agent lasts before it lapses on its own. */
export const DEFAULT_GRANT_MINUTES = 30;

function stateDir(): string {
  return join(homedir(), ".local", "state", "clickr");
}

/** Exported for tooling/tests that want to know exactly where state lives. */
export function stateFilePath(): string {
  return join(stateDir(), "controls.json");
}

function ensureStateDir(): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function userHolderNow(): ControlsState {
  return { holder: "user", since: new Date().toISOString() };
}

/**
 * Reads the control state fresh from disk -- no caching, deliberately. That is what
 * lets the operator run `clickr controls me` in another terminal and have it take
 * effect at the very next tool call, mid-sequence, without the agent's process needing
 * a restart or a nudge.
 *
 * Fails closed: a missing file, an unreadable file, malformed JSON, an unrecognised
 * holder value, or an expired grant all collapse to the same safe default, holder
 * "user". This function must never throw.
 */
export function readControls(): ControlsState {
  try {
    const raw = readFileSync(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return userHolderNow();
    if (parsed.holder !== "user" && parsed.holder !== "agent") return userHolderNow();
    if (typeof parsed.since !== "string") return userHolderNow();

    if (parsed.holder === "agent") {
      // An agent grant must carry a valid, still-future expiry, or it has lapsed.
      if (typeof parsed.until !== "string") return userHolderNow();
      const untilMs = Date.parse(parsed.until);
      if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return userHolderNow();
    }

    const state: ControlsState = { holder: parsed.holder, since: parsed.since };
    if (typeof parsed.until === "string") state.until = parsed.until;
    if (typeof parsed.note === "string") state.note = parsed.note;
    return state;
  } catch {
    return userHolderNow();
  }
}

function writeState(state: ControlsState): ControlsState {
  ensureStateDir();
  writeFileSync(stateFilePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

/** Grants control to the agent for `minutes` (default DEFAULT_GRANT_MINUTES), starting now. */
export function grantToAgent(note?: string, minutes: number = DEFAULT_GRANT_MINUTES): ControlsState {
  const now = new Date();
  const until = new Date(now.getTime() + minutes * 60_000);
  const state: ControlsState = {
    holder: "agent",
    since: now.toISOString(),
    until: until.toISOString(),
  };
  if (note) state.note = note;
  return writeState(state);
}

/** Returns control to the operator. */
export function returnToUser(note?: string): ControlsState {
  const state: ControlsState = { holder: "user", since: new Date().toISOString() };
  if (note) state.note = note;
  return writeState(state);
}

/**
 * Extends an active agent grant's expiry by `minutes` from now, keeping its original
 * `since` and `note`. Called after every successful actuating tool call so a session
 * that is actively in use keeps control, while one that goes quiet lapses on its own.
 *
 * No-op if the agent does not currently hold control. Best-effort: a failure here must
 * never break the tool call that triggered it, so errors are swallowed.
 */
export function refreshGrant(minutes: number = DEFAULT_GRANT_MINUTES): void {
  try {
    const current = readControls();
    if (current.holder !== "agent") return;
    const until = new Date(Date.now() + minutes * 60_000);
    const state: ControlsState = {
      holder: "agent",
      since: current.since,
      until: until.toISOString(),
    };
    if (current.note) state.note = current.note;
    writeState(state);
  } catch {
    // Best-effort refresh; if it fails the existing grant simply expires on schedule.
  }
}

/**
 * Tools that touch the real mouse, keyboard, clipboard, or window layout. Gated on
 * agent control and required to carry a `step` argument. Exported as the single source
 * of truth so index.ts (the gate) and tools.ts (the schemas) never have to keep a
 * second list in sync.
 */
export const ACTUATING_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "move_mouse",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "activate_app",
  "set_window_bounds",
  "set_clipboard",
]);

/** Tools that only observe. Never gated, always available regardless of control state. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "check_permissions",
  "list_displays",
  "list_windows",
  "list_apps",
  "screenshot",
  "find_elements",
  "element_at",
  "read_text",
  "get_mouse_position",
  "get_clipboard",
]);

export function isActuating(toolName: string): boolean {
  return ACTUATING_TOOLS.has(toolName);
}

/** Message returned to the model when an actuating tool is called without control. */
export function handoverMessage(): string {
  return (
    "Clickr is not under agent control. The operator holds the controls. " +
    'They can hand over by saying "your controls", or by running `clickr controls you`. ' +
    "Read-only tools (screenshot, read_text, find_elements, list_windows) still work " +
    "-- you can look, but not touch."
  );
}
