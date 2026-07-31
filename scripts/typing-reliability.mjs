// Measures typing fidelity across repeated trials and several inter-key delays.
// Reads the exact textarea contents back out of the window title, so there is no
// clipboard involved and nothing to confuse a failed copy with a failed type.
import { spawn, execFileSync } from "node:child_process";

const PHRASE = "clickr ✓ Grüße, équipe — 日本語 123";
const TRIALS = Number(process.argv[2] ?? 4);
const DELAYS = (process.argv[3] ?? "8,20,40").split(",").map(Number);

const p = spawn("./bin/clickr-helper");
let buf = "";
const q = [];
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (l.trim()) q.shift()(JSON.parse(l));
  }
});
const send = (o) => new Promise((r) => { q.push(r); p.stdin.write(JSON.stringify(o) + "\n"); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hash(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0;
  return x.toString(36);
}
const EXPECTED = `L${PHRASE.length}H${hash(PHRASE)}`;
const EMPTY = `L0H${hash("")}`;

async function findPage() {
  const wins = (await send({ cmd: "windows", app: "Chrome" })).windows;
  return wins.find((w) => /^L\d+H[a-z0-9]+F[01]$/.test(w.title));
}
/** Returns "L<len>H<hash>" — identifies the field contents without risking truncation. */
async function value() {
  const w = await findPage();
  if (!w) return null;
  return w.title.replace(/F[01]$/, "");
}

execFileSync("/usr/bin/open", ["-a", "Google Chrome", "/tmp/clickr-dbg2.html"]);
await sleep(3000);
await send({ cmd: "activate", name: "Google Chrome" });
await sleep(800);

const page = await findPage();
if (!page) { console.log("test page not found"); p.kill(); process.exit(1); }
await send({ cmd: "click", x: Math.round(page.x + page.width / 2), y: Math.round(page.y + 150) });
await sleep(500);

for (const delay of DELAYS) {
  let ok = 0;
  const bad = [];
  for (let t = 0; t < TRIALS; t++) {
    await send({ cmd: "key", key: "a", modifiers: ["cmd"] });
    await sleep(150);
    await send({ cmd: "key", key: "delete" });
    await sleep(300);
    if ((await value()) !== EMPTY) { bad.push("clear-failed"); continue; }

    await send({ cmd: "type", text: PHRASE, delay });
    // Poll until the value stops changing, so we never measure a half-typed state.
    let prev = null, got = null;
    for (let i = 0; i < 25; i++) {
      await sleep(120);
      got = await value();
      if (got === prev && got !== EMPTY) break;
      prev = got;
    }
    if (got === EXPECTED) ok++;
    else bad.push(String(got));
  }
  console.log(`delay ${String(delay).padStart(3)}ms: ${ok}/${TRIALS} exact` +
    (bad.length ? `  failures: ${bad.slice(0, 3).join(" | ")}` : ""));
}
p.kill();
