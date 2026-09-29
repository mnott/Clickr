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
  checkAgentIdentity,
  delegateControl,
  grantToAgent,
  parseGrantDuration,
  reapDeadHolder,
  readControls,
  refreshGrant,
  returnControl,
  returnToUser,
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

console.log("\nCLI parses --agent alongside a window and note");
runCli("me");
const agentCliOut = runCli("you", "--agent", "w1", "for", "2h", "note");
const afterAgentCli = readControls();
check("agentId parsed from --agent", afterAgentCli.agentId === "w1", afterAgentCli.agentId);
check("window still parsed after --agent", afterAgentCli.minutes === 120, afterAgentCli.minutes);
check("note still kept after --agent and window", afterAgentCli.note === "note", afterAgentCli.note);
check("status shows the agent id", /agent:\s*w1/.test(runCli("status")));

console.log("\n`me` clears the agent identity");
runCli("me");
check("agentId cleared", readControls().agentId === null);
check("agentPid cleared", readControls().agentPid === null);
check("returnTo cleared", readControls().returnTo.length === 0);

console.log("\nan old state file written before agentId existed loads as null");
grantToAgent(undefined, 60);
const legacyNoAgent = readControls();
delete legacyNoAgent.agentId;
delete legacyNoAgent.agentPid;
delete legacyNoAgent.returnTo;
execFileSync(process.execPath, [
  "-e",
  `require("fs").writeFileSync(${JSON.stringify(stateFilePath())}, ${JSON.stringify(JSON.stringify(legacyNoAgent))})`,
]);
const loadedLegacy = readControls();
check("agentId defaults to null", loadedLegacy.agentId === null, loadedLegacy.agentId);
check("agentPid defaults to null", loadedLegacy.agentPid === null, loadedLegacy.agentPid);
check("returnTo defaults to []", Array.isArray(loadedLegacy.returnTo) && loadedLegacy.returnTo.length === 0);

console.log("\nthe identity gate (checkAgentIdentity)");
check("agentId w1 + env w1 -> allowed", checkAgentIdentity({ agentId: "w1" }, "w1") === null);
check(
  "agentId w1 + env w2 -> refused, names the holder",
  /worker w1/.test(checkAgentIdentity({ agentId: "w1" }, "w2") ?? "")
);
check(
  "agentId w1 + no env -> refused",
  typeof checkAgentIdentity({ agentId: "w1" }, undefined) === "string"
);
check("agentId null + no env -> allowed (interactive session)", checkAgentIdentity({ agentId: null }, undefined) === null);
check(
  "agentId null + env w1 -> refused, tells the worker to ask for delegation",
  /session, not to this worker/.test(checkAgentIdentity({ agentId: null }, "w1") ?? "")
);

console.log("\ndelegating a session's grant to one worker, and back");
returnToUser();
grantToAgent(undefined, 360); // the operator's "your controls for 6 hours" to the session
const sessionGrant = readControls();
check("session grant starts untargeted", sessionGrant.agentId === null);

delegateControl("w1", 111);
const delegatedToW1 = readControls();
check("delegated agentId is the worker", delegatedToW1.agentId === "w1");
check("delegated agentPid is recorded", delegatedToW1.agentPid === 111);
check(
  "return stack holds the session (null)",
  delegatedToW1.returnTo.length === 1 && delegatedToW1.returnTo[0].agentId === null
);
check(
  "delegation does not shorten or reset the overnight grant",
  delegatedToW1.until === sessionGrant.until && delegatedToW1.minutes === sessionGrant.minutes
);

delegateControl("w2", 222);
const nested = readControls();
check("nested delegation targets w2", nested.agentId === "w2");
check(
  "return stack is [session, w1], most recent last",
  nested.returnTo.length === 2 && nested.returnTo[0].agentId === null && nested.returnTo[1].agentId === "w1"
);
check("nested delegation still keeps the original expiry", nested.until === sessionGrant.until);

const returnedFromW2 = returnControl("w2");
check("w2 returning pops back to w1", returnedFromW2.popped && returnedFromW2.state.agentId === "w1");
check("return stack shrinks by one", readControls().returnTo.length === 1);

const wrongReturn = returnControl("w2");
check("a worker that no longer holds it can't return -- no-op", wrongReturn.popped === false);
check("state is unchanged by the no-op return", readControls().agentId === "w1");

const returnedFromW1 = returnControl("w1");
check("w1 returning pops back to the session", returnedFromW1.popped && returnedFromW1.state.agentId === null);
check("return stack is empty again", readControls().returnTo.length === 0);

console.log("\ncrash recovery: a dead worker's delegated grant is reaped, repeatedly if needed");
returnToUser();
grantToAgent(undefined, 360);
delegateControl("w1", 999998); // pid far outside any real process range -- reliably dead
delegateControl("w2", 999999); // also dead, so the reap must skip past w1 too
const beforeReap = readControls();
check("both delegated pids are dead before reaping", beforeReap.agentId === "w2");

const reaped = reapDeadHolder(beforeReap);
check("holder stays agent", reaped.holder === "agent");
check("reap skips past the also-dead w1 straight to the session", reaped.agentId === null, reaped.agentId);
check("return stack is drained", reaped.returnTo.length === 0);
check("reap is persisted to disk", readControls().agentId === null);
check(
  "next gate check from the session (no PAI_WORKER_ID) is allowed",
  checkAgentIdentity(reaped, undefined) === null
);
check(
  "next gate check from an unrelated worker is still refused",
  typeof checkAgentIdentity(reaped, "w9") === "string"
);

console.log("\n\"your controls\" inside a worker's own session binds the grant to that worker");
returnToUser();
const wGrant = grantToAgent(undefined, undefined, "w-self");
check("agentId is the worker's own id", wGrant.agentId === "w-self", wGrant.agentId);
check("no pid recorded (would let reapDeadHolder drop it)", wGrant.agentPid === null, wGrant.agentPid);
check(
  "that same worker's identity check now passes",
  checkAgentIdentity(readControls(), "w-self") === null
);

returnToUser();
const plainGrant = grantToAgent();
check("PAI_WORKER_ID unset -> agentId stays null (unchanged behaviour)", plainGrant.agentId === null);
check(
  "an interactive session (no env) still passes the identity check",
  checkAgentIdentity(readControls(), undefined) === null
);

console.log("\nthe hook binds the grant to PAI_WORKER_ID when the hook itself runs inside a worker");
returnToUser();
function runHookAsWorker(prompt, workerId) {
  const out = execFileSync(process.execPath, [join(repoRoot, "dist", "hook.js")], {
    input: JSON.stringify({ prompt }),
    env: { ...process.env, HOME: sandboxHome, PAI_WORKER_ID: workerId },
    encoding: "utf8",
  });
  return { out: out.trim(), state: readControls() };
}
const hookAsWorker = runHookAsWorker("ok, your controls", "w-hook");
check("hook grant is targeted at the worker", hookAsWorker.state.agentId === "w-hook", hookAsWorker.state.agentId);
check(
  "that worker's own identity check now passes",
  checkAgentIdentity(hookAsWorker.state, "w-hook") === null
);

returnToUser();
rmSync(sandboxHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
