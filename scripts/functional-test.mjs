// End-to-end proof against a real, unmodified app: Google Chrome.
//
// The test page continuously reports its own viewport origin, the text it has
// actually received, and the coordinates of the last click it saw — all through
// the window title, which clickr can read via list_windows. That verifies the
// whole loop numerically (global point -> CGEvent -> Chrome viewport -> DOM)
// instead of just checking that something happened.
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const PAGE = "/tmp/clickr-functional-test.html";
const PHRASE = "clickr ✓ Grüße, équipe — 日本語 123";
const APP = "Google Chrome";
const SENTINEL = "___CLICKR_CLIPBOARD_SENTINEL___";

// Target square at a known CSS offset; its centre is (260, 340) in page space.
const TARGET = { left: 200, top: 300, width: 120, height: 80 };
const TARGET_CENTER = { x: TARGET.left + TARGET.width / 2, y: TARGET.top + TARGET.height / 2 };

writeFileSync(
  PAGE,
  `<!doctype html><meta charset="utf-8"><title>booting</title>
<style>
  html,body{margin:0;padding:0;height:100%;font:14px -apple-system,sans-serif;background:#f4f4f7}
  #out{position:absolute;left:0;top:0;width:100%;height:180px;box-sizing:border-box;
       border:0;border-bottom:2px solid #bbb;padding:10px;font:13px Menlo,monospace}
  #target{position:absolute;left:${TARGET.left}px;top:${TARGET.top}px;
          width:${TARGET.width}px;height:${TARGET.height}px;background:#e6194b;color:#fff;
          display:flex;align-items:center;justify-content:center;font-weight:700}
</style>
<textarea id="out" spellcheck="false"></textarea>
<div id="target">TARGET</div>
<script>
  var lastHit = "-";
  var out = document.getElementById('out');
  document.getElementById('target').addEventListener('click', function (e) {
    lastHit = Math.round(e.clientX) + "," + Math.round(e.clientY);
  });
  // Polled, not event-driven: moving a window fires no resize event in Chrome,
  // so a resize listener alone would report a stale origin after a move.
  setInterval(function () {
    var ox = Math.round(window.screenX);
    var oy = Math.round(window.screenY + (window.outerHeight - window.innerHeight));
    document.title = "O " + ox + " " + oy + " L " + out.value.length +
                     " F " + (document.activeElement === out ? "1" : "0") +
                     " H " + lastHit;
  }, 150);
</script>`
);

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
    const m = JSON.parse(line);
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
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const txt = (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.result?.isError) throw new Error(`${name} failed: ${txt}`);
  return txt;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fails = [];
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fails.push(label);
};

/** Reads the test page's state out of the Chrome window title. */
async function state() {
  const wins = JSON.parse(await call("list_windows", { app: "Google Chrome" })).windows;
  const w = wins.find((w) => /^O -?\d+ -?\d+ L /.test(w.title));
  if (!w) return { win: wins[0], raw: wins.map((x) => x.title).join(" ~ ") };
  const m = w.title.match(/^O (-?\d+) (-?\d+) L (\d+) F ([01]) H (\S+)/);
  return {
    win: w,
    raw: w.title,
    originX: Number(m[1]),
    originY: Number(m[2]),
    length: Number(m[3]),
    focused: m[4] === "1",
    hit: m[5],
  };
}

/** Copies the focused selection, using a sentinel so a failed copy cannot pass silently. */
async function copySelection() {
  await call("set_clipboard", { text: SENTINEL });
  await sleep(120);
  await call("press_key", { key: "a", modifiers: ["cmd"], app: APP });
  await sleep(220);
  await call("press_key", { key: "c", modifiers: ["cmd"], app: APP });
  await sleep(550);
  const got = JSON.parse(await call("get_clipboard")).text;
  return got === SENTINEL ? null : got;
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fn", version: "1" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const before = JSON.parse(await call("list_apps")).apps.find((a) => a.active);
const savedClipboard = JSON.parse(await call("get_clipboard"));

execFileSync("/usr/bin/open", ["-a", "Google Chrome", PAGE]);
await sleep(3000);
await call("activate_app", { name: "Google Chrome" });
await sleep(1000);

let s = await state();
check("found Chrome test window", s.originX !== undefined,
  s.win ? `[${s.win.windowId}] "${s.raw}" at (${s.win.x},${s.win.y}) ${s.win.width}x${s.win.height}` : "none");
if (s.originX === undefined) { proc.kill(); process.exit(1); }

const windowId = s.win.windowId;
const originalBounds = { x: s.win.x, y: s.win.y, width: s.win.width, height: s.win.height };
console.log(`      viewport origin (${s.originX}, ${s.originY}); window id ${windowId}`);

check("clickr window bounds agree with Chrome's own screenX",
  Math.abs(s.originX - s.win.x) <= 2, `clickr x=${s.win.x}, Chrome screenX=${s.originX}`);

// --- Core claim: a computed global coordinate lands exactly where intended. ---
await call("click", {
  x: Math.round(s.originX + TARGET_CENTER.x),
  y: Math.round(s.originY + TARGET_CENTER.y),
});
await sleep(600);
s = await state();
const [hx, hy] = s.hit.split(",").map(Number);
check("click landed exactly on the intended point", hx === TARGET_CENTER.x && hy === TARGET_CENTER.y,
  `intended (${TARGET_CENTER.x}, ${TARGET_CENTER.y}), page received (${s.hit})`);

// --- Typing into a real form field, including non-ASCII. ---
await call("click", { x: Math.round(s.originX + 300), y: Math.round(s.originY + 60) });
await sleep(450);
s = await state();
check("click focused the text field", s.focused, `activeElement is textarea: ${s.focused}`);

const typed = JSON.parse(await call("type_text", { text: PHRASE, app: APP }));
check("typing reported the intended destination app", typed.frontmostApp === APP,
  `text went to "${typed.frontmostApp}"`);
await sleep(900);
s = await state();
check("page received the right number of characters", s.length === PHRASE.length,
  `expected ${PHRASE.length}, page has ${s.length}`);

const got = await copySelection();
check("typed Unicode text round-trips exactly", got === PHRASE,
  got === null ? "copy produced nothing (clipboard sentinel survived)" : JSON.stringify(got));

// --- Paste mode: the fast path for long text. ---
const LONG = "Paste path: " + "abcdefghij ".repeat(20).trim();
await call("press_key", { key: "a", modifiers: ["cmd"], app: APP });
await sleep(150);
await call("type_text", { text: LONG, method: "paste", app: APP });
await sleep(800);
s = await state();
check("paste mode delivered the whole string", s.length === LONG.length,
  `expected ${LONG.length}, page has ${s.length}`);
const gotLong = await copySelection();
check("paste-mode text round-trips exactly", gotLong === LONG,
  gotLong === null ? "copy produced nothing" : `${gotLong.length} chars`);

// --- Window geometry. Off by default: this is the user's own Chrome window and
// --- shoving it around mid-session is obnoxious. Run with MOVE_WINDOW=1 to check.
let moved = { x: s.win.x, y: s.win.y, width: s.win.width, height: s.win.height };
if (process.env.MOVE_WINDOW === "1") {
  moved = JSON.parse(await call("set_window_bounds", {
    windowId, x: 150, y: 100, width: 900, height: 700,
  }));
  await sleep(1000);
  check("window moved and resized as requested",
    Math.abs(moved.x - 150) <= 6 && Math.abs(moved.y - 100) <= 6 &&
    Math.abs(moved.width - 900) <= 6 && Math.abs(moved.height - 700) <= 6,
    `now (${moved.x},${moved.y}) ${moved.width}x${moved.height} [matched by ${moved.matchedBy}]`);

  s = await state();
  check("the page itself agrees it moved", Math.abs(s.originX - moved.x) <= 3,
    `Chrome screenX=${s.originX}, clickr x=${moved.x}`);

  // Clicking is still exact after the move (nothing is cached).
  await call("click", {
    x: Math.round(s.originX + TARGET_CENTER.x),
    y: Math.round(s.originY + TARGET_CENTER.y),
  });
  await sleep(600);
  const s2 = await state();
  const [hx2, hy2] = s2.hit.split(",").map(Number);
  check("click still exact after the window moved",
    hx2 === TARGET_CENTER.x && hy2 === TARGET_CENTER.y, `page received (${s2.hit})`);

  const restored = JSON.parse(await call("set_window_bounds", { windowId, ...originalBounds }));
  check("original window geometry restored",
    Math.abs(restored.x - originalBounds.x) <= 6 &&
    Math.abs(restored.width - originalBounds.width) <= 6,
    `back to (${restored.x},${restored.y}) ${restored.width}x${restored.height}`);
  await sleep(300);
} else {
  console.log("SKIP  window move/resize checks (set MOVE_WINDOW=1 to include them)");
}

// --- Screenshot of that specific window. ---
const shot = await rpc("tools/call", { name: "screenshot", arguments: { window: windowId, grid: true } });
const img = shot.result?.content?.find((c) => c.type === "image");
check("window screenshot captured", !!img);
if (img) {
  writeFileSync("/tmp/clickr-chrome-shot.png", Buffer.from(img.data, "base64"));
  console.log("      wrote /tmp/clickr-chrome-shot.png");
}

await call("scroll", { x: moved.x + 400, y: moved.y + 400, dy: -3 });
check("scroll executed", true);

// --- Clean up: close only our tab, restore clipboard and focus. ---
await call("press_key", { key: "w", modifiers: ["cmd"], app: APP });
await sleep(700);
if (savedClipboard.hasText) await call("set_clipboard", { text: savedClipboard.text });
if (before) await call("activate_app", { pid: before.pid });
rmSync(PAGE, { force: true });

console.log(fails.length ? `\n${fails.length} FAILURE(S): ${fails.join(", ")}` : "\nAll functional checks passed.");
proc.kill();
process.exit(fails.length ? 1 : 0);
