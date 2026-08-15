import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Append-only log of every actuating tool call: timestamp, tool, the step sentence the
 * model gave, and a compact summary of its arguments. Lets the operator run
 * `clickr steps` in another terminal to see what the agent has been doing to their
 * machine, independent of scrolling back through the conversation.
 *
 * Logging is diagnostic, never load-bearing: every function here is best-effort and
 * must never throw or block a tool call.
 */

function stateDir(): string {
  return join(homedir(), ".local", "state", "clickr");
}

export function stepsLogPath(): string {
  return join(stateDir(), "steps.log");
}

/** Cap the log around ~1 MB by truncating to the most recent lines. */
const MAX_BYTES = 1_000_000;
const KEEP_LINES_ON_TRUNCATE = 500;

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const parts = Object.entries(args).map(([key, value]) => {
      let rendered: string;
      if (typeof value === "string") {
        rendered = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      } else {
        rendered = JSON.stringify(value);
      }
      return `${key}=${rendered}`;
    });
    return parts.join(" ");
  } catch {
    return "";
  }
}

function truncateIfLarge(file: string): void {
  try {
    if (statSync(file).size <= MAX_BYTES) return;
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const kept = lines.slice(-KEEP_LINES_ON_TRUNCATE);
    writeFileSync(file, kept.join("\n") + "\n", "utf8");
  } catch {
    // Best-effort cap only.
  }
}

/**
 * The announcement, in the operator's own convention.
 *
 * `[YYYY-MM-DD HH:MM] Next clickr step: …` is the exact form the operator asks
 * for by hand, so producing it here rather than relying on the model to type it
 * makes the two indistinguishable — and makes it greppable across the log, the
 * transcript and the terminal at once. Local time, because it is read by a
 * person sitting at the machine, not correlated with a server somewhere.
 */
export function announcement(step: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `[${stamp}] Next clickr step: ${step}`;
}

/**
 * Appends one line for an actuating tool call. Never throws.
 *
 * CALLED BEFORE THE ACTION, NOT AFTER. It used to be written only once the call
 * had returned successfully, which meant the single case where the record
 * matters most — a click that hung, froze the machine or never came back — was
 * the one case that left nothing behind. An intent recorded after the fact is
 * not a record of intent, it is a record of outcome.
 *
 * `outcome` is filled in by a second call once the result is known, so the log
 * distinguishes "about to" from "did" without losing either.
 */
export function logStep(
  toolName: string,
  step: string,
  args: Record<string, unknown>,
  outcome: "start" | "ok" | "failed" = "start",
): void {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = stepsLogPath();
    const line = `${new Date().toISOString()}\t${outcome}\t${toolName}\t${step}\t${summarizeArgs(args)}\n`;
    appendFileSync(file, line, "utf8");
    truncateIfLarge(file);
  } catch {
    // Logging must never block or fail a tool call.
  }
}

/** Reads the last `n` lines of the step log, oldest of the selection first. Never throws. */
export function readLastSteps(n: number): string[] {
  try {
    const lines = readFileSync(stepsLogPath(), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}
