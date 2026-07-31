#!/usr/bin/env node
// Command-line driver for the clickr MCP server.
//
// Speaks the real MCP protocol over stdio to dist/index.js, so anything done here
// exercises exactly the same code path a Claude Code session would use.
//
//   node scripts/clickr.mjs <tool> '<json-args>'
//   node scripts/clickr.mjs --batch '[["tool",{...}], ["tool",{...}]]'
//
// Images are written to /tmp/clickr-shot-<n>.png and the path is printed.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const proc = spawn("node", [join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
});
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

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "clickr-cli", version: "1" },
});
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let shotCount = 0;
async function callTool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args ?? {} });
  const content = r.result?.content ?? [];
  for (const c of content) {
    if (c.type === "text") console.log(c.text);
    else if (c.type === "image") {
      const p = `/tmp/clickr-shot-${++shotCount}.png`;
      writeFileSync(p, Buffer.from(c.data, "base64"));
      console.log(`[image saved: ${p}]`);
    }
  }
  if (r.result?.isError) {
    console.error(`(tool "${name}" reported an error)`);
    return false;
  }
  return true;
}

const argv = process.argv.slice(2);
let ok = true;

if (argv[0] === "--batch") {
  const steps = JSON.parse(argv[1]);
  // A settle pause between every step: UI automation that fires calls back to
  // back outruns the application it is driving (pages navigate, fields focus,
  // menus animate). Steps can also pause explicitly with ["wait", {"ms": N}].
  const gap = Number(process.env.CLICKR_STEP_MS ?? 700);
  for (const [name, args] of steps) {
    if (name === "wait") {
      const ms = Number(args?.ms ?? 1000);
      console.log(`\n--- wait ${ms}ms`);
      await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    console.log(`\n--- ${name} ${JSON.stringify(args ?? {})}`);
    ok = (await callTool(name, args)) && ok;
    if (!ok) break;
    await new Promise((r) => setTimeout(r, gap));
  }
} else if (argv[0] === "--list") {
  const r = await rpc("tools/list", {});
  for (const t of r.result.tools) console.log(t.name);
} else if (argv[0]) {
  ok = await callTool(argv[0], argv[1] ? JSON.parse(argv[1]) : {});
} else {
  console.log("usage: clickr.mjs <tool> '<json>' | --batch '<json>' | --list");
}

proc.kill();
process.exit(ok ? 0 : 1);
