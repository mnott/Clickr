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

/** Appends one line for a successful actuating tool call. Never throws. */
export function logStep(toolName: string, step: string, args: Record<string, unknown>): void {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = stepsLogPath();
    const line = `${new Date().toISOString()}\t${toolName}\t${step}\t${summarizeArgs(args)}\n`;
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
