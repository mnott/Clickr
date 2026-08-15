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
  /**
   * The length of the idle window this grant was made with, in minutes. Persisted
   * rather than recomputed because every actuating call refreshes `until`: without it,
   * a refresh would silently reset a deliberately long grant back to the default.
   */
  minutes?: number;
  note?: string;
}

/** How long a grant to the agent lasts before it lapses on its own. */
export const DEFAULT_GRANT_MINUTES = 30;

/** Upper bound on a grant window. A grant is an idle timer, not a permanent unlock. */
export const MAX_GRANT_MINUTES = 24 * 60;

/** Clamps a requested grant window to something sane; falls back to the default. */
export function normalizeGrantMinutes(minutes?: number): number {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return DEFAULT_GRANT_MINUTES;
  return Math.min(MAX_GRANT_MINUTES, Math.max(1, Math.round(minutes)));
}

/** Renders a grant window the way a person would say it ("6 hours", "90 minutes"). */
export function formatGrantMinutes(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** Unit words accepted in a spoken or typed grant duration, and their minute value. */
const DURATION_UNITS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:m|mins?|minutes?|minuten?)$/i, 1],
  [/^(?:h|hrs?|hours?|std|stunden?)$/i, 60],
  [/^(?:d|days?|tage?n?)$/i, 60 * 24],
];

/**
 * Anchored at the start of whatever follows the handover phrase, so only a duration
 * the operator actually attached to it is read -- "your controls for 6 hours" yields a
 * grant window, while "your controls, open tab 3" cannot accidentally produce one.
 * The leading filler ("for", "für", "the next") and the article form ("an hour") are
 * optional because people say it both ways.
 *
 * The two amount forms are kept separate on purpose: a digit may sit flush against its
 * unit ("6h"), but an article must be a whole word followed by space, or the "an" in
 * "and then quit" would pair with a "d" and grant a day.
 */
const DURATION_RE =
  /^[\s,;:.!?–—-]*(?:for\s+|f(?:ü|ue)r\s+)?(?:the\s+next\s+|die\s+n(?:ä|ae)chsten\s+|noch\s+)?(?:(\d+(?:[.,]\d+)?)\s*|(an?|eine?[nr]?)\s+)([a-zäü]+)/i;

export interface ParsedGrantDuration {
  /** The requested window, already clamped to [1, MAX_GRANT_MINUTES]. */
  minutes: number;
  /** Whatever text followed the duration, trimmed -- usable as the handover note. */
  rest: string;
}

/**
 * Reads an optional grant duration off the front of `text` (the remainder of the
 * operator's message after "your controls", or the arguments after `clickr controls
 * you`). Returns null when no duration is there, which is the common case and means
 * "use the default window".
 */
export function parseGrantDuration(text: string): ParsedGrantDuration | null {
  const match = DURATION_RE.exec(text);
  if (!match) return null;

  const [whole, digits, article, unitWord] = match;
  const perUnit = DURATION_UNITS.find(([re]) => re.test(unitWord))?.[1];
  if (perUnit === undefined) return null;

  const amount = digits ? parseFloat(digits.replace(",", ".")) : article ? 1 : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    minutes: normalizeGrantMinutes(amount * perUnit),
    rest: text.slice(whole.length).trim(),
  };
}

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
    if (typeof parsed.minutes === "number") state.minutes = parsed.minutes;
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

/**
 * Grants control to the agent, starting now. `minutes` is the idle window: control
 * lapses that long after the last actuating call, not that long after the grant. The
 * window is stored on the state so refreshGrant() can keep honouring it.
 */
export function grantToAgent(note?: string, minutes?: number): ControlsState {
  const window = normalizeGrantMinutes(minutes);
  const now = new Date();
  const until = new Date(now.getTime() + window * 60_000);
  const state: ControlsState = {
    holder: "agent",
    since: now.toISOString(),
    until: until.toISOString(),
    minutes: window,
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
 * Extends an active agent grant's expiry to a full window from now, keeping its
 * original `since`, window length and `note`. Called after every successful actuating
 * tool call so a session that is actively in use keeps control, while one that goes
 * quiet lapses on its own.
 *
 * The window comes from the grant itself, not from the default -- an operator who
 * handed over "for 6 hours" would otherwise find the window collapsing to 30 minutes
 * on the agent's very first click.
 *
 * No-op if the agent does not currently hold control. Best-effort: a failure here must
 * never break the tool call that triggered it, so errors are swallowed.
 */
export function refreshGrant(): void {
  try {
    const current = readControls();
    if (current.holder !== "agent") return;
    const window = normalizeGrantMinutes(current.minutes);
    const until = new Date(Date.now() + window * 60_000);
    const state: ControlsState = {
      holder: "agent",
      since: current.since,
      until: until.toISOString(),
      minutes: window,
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

/**
 * Reads the on-disk state without the fails-closed collapsing that readControls()
 * applies. Returns null if the file is missing, unreadable, or malformed.
 *
 * Exists only so handoverMessage() can tell "an agent grant lapsed" apart from
 * "control was never granted this session" -- readControls() deliberately erases
 * that distinction, because every one of its callers just needs a safe holder to
 * act on, not the history behind it.
 */
function readRawState(): ControlsState | null {
  try {
    const raw = readFileSync(stateFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.holder !== "user" && parsed.holder !== "agent") return null;
    if (typeof parsed.since !== "string") return null;
    const state: ControlsState = { holder: parsed.holder, since: parsed.since };
    if (typeof parsed.until === "string") state.until = parsed.until;
    if (typeof parsed.minutes === "number") state.minutes = parsed.minutes;
    if (typeof parsed.note === "string") state.note = parsed.note;
    return state;
  } catch {
    return null;
  }
}

/** Whether the on-disk state records an agent grant that has since lapsed. */
function isLapsedGrant(raw: ControlsState | null): boolean {
  if (!raw || raw.holder !== "agent") return false;
  if (typeof raw.until !== "string") return true;
  const untilMs = Date.parse(raw.until);
  return !Number.isFinite(untilMs) || untilMs <= Date.now();
}

/**
 * Message returned to the model when an actuating tool is called without control.
 *
 * Branches on why control is missing -- a grant that lapsed reads very differently
 * from one that was never given, and an agent that only ever sees "not under agent
 * control" cannot tell whether the operator's earlier handover was ever registered.
 * Also names the `controls`-tool relay fallback: the primary recovery path is the
 * operator repeating the phrase with clickr's UserPromptSubmit hook installed, but
 * where that hook is not installed nothing observes the conversation, so the agent
 * needs to know it may record an already-spoken handover itself.
 */
export function handoverMessage(): string {
  const raw = readRawState();
  const lapsed = isLapsedGrant(raw);
  const status = lapsed
    ? `Clickr is not under agent control -- the previous grant LAPSED after ` +
      `${formatGrantMinutes(normalizeGrantMinutes(raw?.minutes))} of inactivity and needs to be renewed.`
    : "Clickr is not under agent control -- control was never granted for this session.";
  return (
    status +
    ' The operator can hand it over by saying "your controls", or by running `clickr controls you`. ' +
    'Either form takes an optional window -- "your controls for 6 hours" -- which replaces the ' +
    `default ${formatGrantMinutes(DEFAULT_GRANT_MINUTES)} of idle time before the grant lapses. ` +
    "If the operator has ALREADY said that out loud and it did not take effect -- the " +
    "UserPromptSubmit hook that listens for it may not be installed (`clickr install` sets it " +
    'up) -- the agent may record the handover itself by calling the `controls` tool with ' +
    'holder:"agent", but ONLY in direct response to the operator having just said so, never on ' +
    "its own initiative. Read-only tools (screenshot, read_text, find_elements, list_windows) " +
    "still work -- you can look, but not touch."
  );
}
