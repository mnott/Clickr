// Pins the webContent fix: a search for a role the browser also uses for its own
// controls must reach PAGE content, not fill up with toolbar chrome.
//
// Read-only — find_elements never posts an event.
import { spawn } from "node:child_process";
const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const waiters = new Map();
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
  }
});
let id = 0;
const rpc = (method, params) => new Promise((res) => {
  const myId = ++id; waiters.set(myId, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
});
const find = async (a) => {
  const r = await rpc("tools/call", { name: "find_elements", arguments: a });
  const t = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return { error: t.slice(0, 200) }; }
};
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const app = process.argv[2] ?? "Google Chrome";

// Needs a browser with a page open; skip rather than report a false failure.
const probe = await find({ name: app, maxResults: 1 });
if (probe.error) {
  console.log(`${app} is not running — skipping (this test needs a browser with a page open)`);
  proc.kill();
  process.exit(2);
}

// Baseline: the shape of the bug. A plain AXButton search is all browser chrome.
const plain = await find({ name: app, role: "AXButton" });
// Chrome's own controls live within a few levels of the window; page content is deeper.
const plainDeep = (plain.elements ?? []).filter((e) => (e.depth ?? 0) > 9).length;
console.log(`plain      : count=${plain.count} truncated=${plain.truncated} deep=${plainDeep}`);

const web = await find({ name: app, role: "AXButton", webContent: true });
const webCount = web.count ?? 0;
console.log(`webContent : count=${webCount} truncated=${web.truncated} scope=${web.scope}\n`);

check("webContent reaches page buttons the plain search missed",
  webCount > 0 && plainDeep === 0, `plain found ${plainDeep} page-depth, webContent found ${webCount}`);

check("scope reports the web areas it started from",
  /^webContent \(\d+ area/.test(web.scope ?? ""), web.scope);

// Depths are relative to the web area, so page controls are shallow again — that is
// the point: the cap is now spent on the page rather than on chrome.
check("returned elements carry click coordinates",
  (web.elements ?? []).every((e) => Number.isFinite(e.centerX) && Number.isFinite(e.centerY)));

// A truncated answer must say so in words, not only as a boolean.
const capped = await find({ name: app, maxResults: 5 });
check("truncation carries an actionable note",
  capped.truncated === true && typeof capped.note === "string" && capped.note.includes("webContent"),
  capped.note ? capped.note.slice(0, 60) + "…" : "no note");

// An app with no web content must degrade honestly rather than error.
const native = await find({ name: "Finder", webContent: true });
check("no web area degrades to an honest empty answer",
  native.scope === "webContent (none found)" && (native.count ?? 0) === 0, native.scope);

// Regression: without the flag, behaviour is exactly as before.
check("plain search still returns the app tree", (plain.count ?? 0) > 0);

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
process.exit(fail ? 1 : 0);
