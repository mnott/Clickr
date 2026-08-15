#!/usr/bin/env node
/**
 * UserPromptSubmit hook -- makes the operator's spoken handover phrase authoritative.
 *
 * Without this, nothing observes the conversation: when the operator types "your
 * controls" in their terminal, the state file never changes, so the agent's next
 * actuating call is still refused even though the operator just opened the gate. The
 * previous recovery path put the relay in the hands of the agent (it had to notice the
 * phrase and call the `controls` tool) -- the exact party the gate exists to constrain,
 * and one wasted tool call per handover.
 *
 * `clickr install` registers this script as a UserPromptSubmit hook (see src/cli.ts).
 * Claude Code runs it on every submitted prompt and pipes a JSON payload on stdin
 * carrying, among other fields, the prompt text itself under `prompt`. This hook reads
 * that payload, looks for the handover phrases -- and for an optional window attached
 * to one of them, as in "your controls for 6 hours" -- and if the operator said one, updates
 * clickr's control state directly by calling into ./controls.ts -- no shelling out to
 * the CLI. Anything printed to stdout on a successful (exit 0) run is injected back
 * into the conversation, which is how the operator gets visible confirmation that the
 * handover registered.
 *
 * A hook that throws or exits non-zero disrupts every single prompt the operator
 * types, forever, so every path here is deliberately defensive: malformed JSON, a
 * missing `prompt` field, an empty prompt, and any other failure all fall through to a
 * silent, successful no-op. Only a recognised phrase produces output.
 */
import {
  formatGrantMinutes,
  grantToAgent,
  normalizeGrantMinutes,
  parseGrantDuration,
  returnToUser,
} from "./controls.js";

/** The two phrases this hook acts on, in the order they are checked. */
const PHRASES: ReadonlyArray<readonly ["agent" | "user", string]> = [
  ["agent", "your controls"],
  ["user", "my controls"],
];

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(data));
    } catch {
      resolve(data);
    }
  });
}

/** Extracts the submitted prompt text from a UserPromptSubmit hook payload. */
function extractPrompt(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const prompt = (payload as Record<string, unknown>).prompt;
  return typeof prompt === "string" ? prompt : "";
}

/**
 * Finds which handover phrase occurs LAST in the text, case-insensitively. A plain
 * substring search already tolerates the phrase sitting at the start or end of a
 * longer message and any surrounding punctuation/whitespace, since neither is part of
 * the phrase itself -- "ok, your controls." matches exactly as readily as a bare
 * "your controls". Returns null if neither phrase appears.
 */
function lastHandover(text: string): { holder: "agent" | "user"; tail: string } | null {
  const lower = text.toLowerCase();
  let bestIndex = -1;
  let bestLength = 0;
  let winner: "agent" | "user" | null = null;
  for (const [holder, phrase] of PHRASES) {
    const idx = lower.lastIndexOf(phrase);
    if (idx > bestIndex) {
      bestIndex = idx;
      bestLength = phrase.length;
      winner = holder;
    }
  }
  if (!winner) return null;
  return { holder: winner, tail: text.slice(bestIndex + bestLength) };
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw || !raw.trim()) return;

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const prompt = extractPrompt(payload);
    if (!prompt.trim()) return;

    const handover = lastHandover(prompt);
    if (!handover) return;

    if (handover.holder === "agent") {
      // "your controls for 6 hours" -- an explicit window replaces the default one.
      const requested = parseGrantDuration(handover.tail);
      const state = grantToAgent(undefined, requested?.minutes);
      console.log(
        `Clickr: controls handed to the agent (lapses after ` +
          `${formatGrantMinutes(normalizeGrantMinutes(state.minutes))} idle).`
      );
    } else {
      returnToUser();
      console.log("Clickr: controls returned to the operator.");
    }
  } catch {
    // A hook that throws disrupts every future prompt -- never let anything escape.
  }
}

main().finally(() => process.exit(0));
