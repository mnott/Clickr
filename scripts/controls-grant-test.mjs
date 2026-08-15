#!/usr/bin/env node
/**
 * Verifies the grant window: its default, the phrasings that override it, and the
 * property that actually matters -- that a refresh keeps the operator's chosen window
 * instead of collapsing it back to the default on the agent's first click.
 *
 * Runs entirely against a throwaway HOME, so it never reads or writes the real control
 * state at ~/.local/state/clickr/controls.json. That isolation is the reason the state
 * directory is derived from homedir() on every call rather than cached at import.
 *
 * Read-only with respect to the machine: no window is touched, no event is posted.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxHome = mkdtempSync(join(tmpdir(), "clickr-controls-test-"));
process.env.HOME = sandboxHome;

const {
  DEFAULT_GRANT_MINUTES,
  MAX_GRANT_MINUTES,
  grantToAgent,
  parseGrantDuration,
  readControls,
  refreshGrant,
  stateFilePath,
} = await import(join(repoRoot, "dist", "controls.js"));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function minutesUntil(state) {
  return Math.round((Date.parse(state.until) - Date.now()) / 60_000);
}

console.log("\nparsing a window off the end of a handover phrase");
for (const [text, expected] of [
  [" for 6 hours", 360],
  [" for 6h", 360],
  [" 6h", 360],
  [" for 90 minutes", 90],
  [" 90m", 90],
  [" for 2.5 hours", 150],
  [" for an hour", 60],
  [" for a day", 1440],
  [" für 6 Stunden", 360],
  [" for the next 2 hours", 120],
  [" for 3 days", MAX_GRANT_MINUTES], // clamped
  [" for 0 hours", null],
]) {
  const got = parseGrantDuration(text);
  check(`"${text.trim()}" -> ${expected}`, (got?.minutes ?? null) === expected, `got ${got?.minutes ?? null}`);
}

console.log("\ntext that is not a window must not be read as one");
for (const text of ["", ", open tab 3", " please", " a moment", " and then quit"]) {
  check(`"${text}" -> no window`, parseGrantDuration(text) === null);
}

console.log("\nthe note survives alongside the window");
const parsed = parseGrantDuration(" for 6 hours while I run errands");
check("window parsed", parsed?.minutes === 360);
check("remainder kept as note", parsed?.rest === "while I run errands", `got "${parsed?.rest}"`);

console.log("\ngranting");
const def = grantToAgent();
check(`default window is ${DEFAULT_GRANT_MINUTES} min`, def.minutes === DEFAULT_GRANT_MINUTES);
check("default expiry matches the window", Math.abs(minutesUntil(def) - DEFAULT_GRANT_MINUTES) <= 1);

const long = grantToAgent(undefined, 360);
check("explicit window is recorded", long.minutes === 360);
check("explicit expiry matches the window", Math.abs(minutesUntil(long) - 360) <= 1);
check("window is persisted to disk", JSON.parse(readFileSync(stateFilePath(), "utf8")).minutes === 360);
check("window survives a read", readControls().minutes === 360);

const clamped = grantToAgent(undefined, 99999);
check(`window is clamped to ${MAX_GRANT_MINUTES}`, clamped.minutes === MAX_GRANT_MINUTES);

console.log("\nrefreshing keeps the window (the regression this guards)");
grantToAgent(undefined, 360);
refreshGrant();
const refreshed = readControls();
check("window unchanged after refresh", refreshed.minutes === 360, `got ${refreshed.minutes}`);
check("expiry pushed a full window out", Math.abs(minutesUntil(refreshed) - 360) <= 1, `got ${minutesUntil(refreshed)} min`);

console.log("\na grant written before windows existed still refreshes");
grantToAgent(undefined, 360);
const legacy = readControls();
delete legacy.minutes;
execFileSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(stateFilePath())}, ${JSON.stringify(JSON.stringify(legacy))})`]);
refreshGrant();
check(`falls back to the ${DEFAULT_GRANT_MINUTES} min default`, readControls().minutes === DEFAULT_GRANT_MINUTES);

console.log("\nthe UserPromptSubmit hook carries the window through");
function runHook(prompt) {
  const out = execFileSync(process.execPath, [join(repoRoot, "dist", "hook.js")], {
    input: JSON.stringify({ prompt }),
    env: { ...process.env, HOME: sandboxHome },
    encoding: "utf8",
  });
  return { out: out.trim(), state: readControls() };
}

const spoken = runHook("ok, your controls for 6 hours");
check("hook grants for 6 hours", spoken.state.holder === "agent" && spoken.state.minutes === 360, `got ${spoken.state.minutes}`);
check("hook says so out loud", /6 hours/.test(spoken.out), spoken.out);

const bare = runHook("your controls");
check("bare phrase uses the default", bare.state.minutes === DEFAULT_GRANT_MINUTES);

const back = runHook("my controls");
check("handing back returns the operator", back.state.holder === "user");

const noise = runHook("your controls, open tab 3 and click save");
check("a digit later in the sentence is not a window", noise.state.minutes === DEFAULT_GRANT_MINUTES, `got ${noise.state.minutes}`);

console.log("\nthe CLI accepts the same phrasing");
function runCli(...args) {
  return execFileSync(process.execPath, [join(repoRoot, "dist", "cli.js"), "controls", ...args], {
    env: { ...process.env, HOME: sandboxHome },
    encoding: "utf8",
  }).trim();
}

const cliOut = runCli("you", "for", "6", "hours");
check("`controls you for 6 hours`", readControls().minutes === 360, cliOut);
check("CLI reports the window", /6 hours/.test(cliOut), cliOut);

runCli("you", "6h", "installing updates");
check("`controls you 6h <note>` keeps both", readControls().minutes === 360 && readControls().note === "installing updates");

const statusOut = runCli("status");
check("status shows the window", /window:\s*6 hours/.test(statusOut), statusOut);

runCli("you");
check("bare `controls you` uses the default", readControls().minutes === DEFAULT_GRANT_MINUTES);

rmSync(sandboxHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
