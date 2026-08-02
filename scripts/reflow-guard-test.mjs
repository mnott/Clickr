// Proves the expectRole/expectTitle reflow guard: a stale coordinate whose control
// changed underneath must be REFUSED before any event is posted.
//
// Safety: the guard runs before the click, so a refusal posts nothing. The cases that
// are EXPECTED to pass the guard do post a click, so they are aimed at AXStaticText —
// a label, where a click is inert. Nothing here can alter the user's state.
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiters = new Map();
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); w(m); }
  }
});

let id = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const myId = ++id;
    waiters.set(myId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });

const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
  return { refused: /refusing to act/.test(text), text };
};

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail) console.log(`      ${String(detail).slice(0, 300)}`);
  ok ? pass++ : fail++;
};

await rpc("initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reflow-test", version: "0" },
});

// Probe by point rather than walking the tree: element_at is a single AX hit-test,
// where find_elements over a mail client's full tree ran past 180s.
//
// Target the frontmost window's TITLE BAR. Two reasons: clicking a title bar is inert
// (it raises an already-frontmost window), and the window title is stable, where a
// terminal's AXTextArea value is the scrollback and changes between the read and the
// click — which would make the test flap rather than fail honestly.
let target = null, at = null;
for (const x of [300, 500, 800, 1200]) {
  for (const y of [60, 45, 70]) {
    const r = await call("element_at", { x, y });
    if (r.refused || /error/i.test(r.text)) continue;
    let el;
    try { el = JSON.parse(r.text).element; } catch { continue; }
    if (el && /Window/i.test(el.role ?? "") && el.title) { target = el; at = { x, y }; break; }
  }
  if (target) break;
}
if (!target) { console.log("no window title bar found; cannot run safely"); process.exit(2); }

const label = target.title;
console.log(`target: ${target.role} "${label}" at ${at.x},${at.y} (title bar — inert)\n`);

// 1. The core case: the coordinate now resolves to a different KIND of control.
//    Exactly what reflow produces, and precisely what expectGeometry cannot see.
{
  const r = await call("click", { ...at, expectRole: "AXCheckBox" });
  check("wrong role is refused", r.refused, r.text);
  check("  ...and the message names what is really there", /window/i.test(r.text), r.text);
}

// 2. Right kind of control, wrong one — a toolbar that shifted by a single button.
{
  const r = await call("click", { ...at, expectRole: target.role, expectTitle: "Delete Everything" });
  check("right role but wrong label is refused", r.refused, r.text);
}

// 3. The control vanished entirely; reflow removes as well as moves.
//    Only safe while the guard exists: a refusal posts nothing, but WITHOUT the guard
//    this would post a click at a coordinate macOS clamps to a screen corner — i.e.
//    into the menu bar. Skipped when deliberately running against the pre-fix binary.
if (!process.env.SKIP_OFFSCREEN) {
  const r = await call("click", { x: -30000, y: -30000, expectRole: "AXButton" });
  check("no element at the point is refused", r.refused, r.text);
}

// 4. A correct expectation must not refuse. This one does click — on the label.
{
  const r = await call("click", { ...at, expectRole: target.role, expectTitle: label });
  check("correct role + title passes the guard", !r.refused, r.text);
}

// 5. find_elements reports "AXButton"; a caller may reasonably write "button".
{
  const r = await call("click", { ...at, expectRole: target.role.replace(/^AX/, "") });
  check("unprefixed role spelling accepted", !r.refused, r.text);
}

// 6. Regression: with no expectation the guard must not engage at all, or clickr's
//    own niche (canvas, games, remote desktop — no accessibility tree) breaks.
{
  const r = await call("click", { ...at });
  check("unguarded click is unaffected", !r.refused, r.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
process.exit(fail ? 1 : 0);
