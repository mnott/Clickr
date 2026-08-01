// Drives the MCP server over real stdio JSON-RPC, the same way a client does.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const outDir = process.argv[2] ?? "/tmp";
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
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
  }
});

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve) => {
    waiters.set(myId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}

const fails = [];
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fails.push(label);
}

function textOf(res) {
  return (res.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1" },
});
check("initialize", init.result?.serverInfo?.name === "clickr", init.result?.serverInfo?.name);
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name);
check("tools/list", names.length === 19, `${names.length} tools: ${names.join(", ")}`);

const perms = await rpc("tools/call", { name: "check_permissions", arguments: {} });
check("check_permissions", !perms.result?.isError, textOf(perms).replace(/\n/g, " | "));

const displays = await rpc("tools/call", { name: "list_displays", arguments: {} });
const dispData = JSON.parse(textOf(displays));
check("list_displays", dispData.displayCount >= 1, `${dispData.displayCount} display(s)`);
console.log("      combined desktop:", JSON.stringify(dispData.combinedDesktopBounds));

const windows = await rpc("tools/call", { name: "list_windows", arguments: {} });
const winData = JSON.parse(textOf(windows));
check("list_windows", winData.windowCount > 0, `${winData.windowCount} window(s)`);

const mouse = await rpc("tools/call", { name: "get_mouse_position", arguments: {} });
check("get_mouse_position", !mouse.result?.isError, textOf(mouse).replace(/\n/g, " "));

// 1:1 region capture — the exactness guarantee the whole design rests on.
const region = await rpc("tools/call", {
  name: "screenshot",
  arguments: { region: { x: 0, y: 0, width: 600, height: 400 }, grid: true },
});
const regionImg = region.result?.content?.find((c) => c.type === "image");
check("screenshot region 1:1", /1 image pixel = 1 point/.test(textOf(region)));
check("screenshot region image", !!regionImg && regionImg.mimeType === "image/png");
if (regionImg) {
  writeFileSync(`${outDir}/test-region-grid.png`, Buffer.from(regionImg.data, "base64"));
  console.log(`      wrote ${outDir}/test-region-grid.png (${regionImg.data.length} b64 chars)`);
}

// Negative-coordinate capture on a secondary display.
if (dispData.displayCount > 1) {
  const second = dispData.displays.find((d) => !d.main);
  const neg = await rpc("tools/call", {
    name: "screenshot",
    arguments: { display: second.index, grid: true, maxDimension: 900 },
  });
  const negImg = neg.result?.content?.find((c) => c.type === "image");
  check("screenshot secondary display", !!negImg, `display ${second.index} at x=${second.bounds.x}`);
  if (negImg) {
    writeFileSync(`${outDir}/test-display2-grid.png`, Buffer.from(negImg.data, "base64"));
    console.log(`      wrote ${outDir}/test-display2-grid.png`);
  }
  const guide = textOf(neg);
  check("secondary display origin reported", guide.includes(`x=${second.bounds.x}`));
}

// Whole-desktop capture across every display.
const all = await rpc("tools/call", { name: "screenshot", arguments: { all: true, maxDimension: 1000 } });
const allImg = all.result?.content?.find((c) => c.type === "image");
check("screenshot all displays", !!allImg);
if (allImg) writeFileSync(`${outDir}/test-all.png`, Buffer.from(allImg.data, "base64"));

// Error paths should be actionable, not stack traces.
const bad = await rpc("tools/call", { name: "screenshot", arguments: { display: 99 } });
check("bad display index errors clearly", bad.result?.isError === true, textOf(bad));

const bothTargets = await rpc("tools/call", {
  name: "screenshot",
  arguments: { display: 1, all: true },
});
check("conflicting targets rejected", bothTargets.result?.isError === true, textOf(bothTargets));

const badKey = await rpc("tools/call", { name: "press_key", arguments: { key: "nope" } });
check("unknown key errors clearly", badKey.result?.isError === true, textOf(badKey).slice(0, 80));

const clip = await rpc("tools/call", { name: "get_clipboard", arguments: {} });
check("get_clipboard", !clip.result?.isError);

// --- Text-based observation: the cheap alternatives to a screenshot. ---
const frontApp = JSON.parse(textOf(await rpc("tools/call", { name: "list_apps", arguments: {} })))
  .apps.find((x) => x.active);
if (frontApp) {
  const els = await rpc("tools/call", {
    name: "find_elements",
    arguments: { pid: frontApp.pid, onlyActionable: true, maxResults: 5 },
  });
  const parsed = JSON.parse(textOf(els));
  check("find_elements returns coordinates as text", parsed.count > 0,
    `${parsed.count} actionable element(s) in ${frontApp.name}`);
  const first = parsed.elements?.[0];
  check("elements carry a click point", first && typeof first.centerX === "number",
    first ? `${first.role} @(${first.centerX},${first.centerY})` : "none");
}

const at = await rpc("tools/call", { name: "element_at", arguments: { x: 100, y: 12 } });
check("element_at describes a point", !at.result?.isError, textOf(at).slice(0, 90));

const ocr = await rpc("tools/call", {
  name: "read_text",
  arguments: { region: { x: 0, y: 0, width: 1000, height: 60 } },
});
const ocrText = textOf(ocr);
check("read_text returns text and no image",
  !ocr.result?.isError &&
    !(ocr.result?.content ?? []).some((c) => c.type === "image"),
  `${ocrText.split("\n").length} line(s), ${ocrText.length} chars`);

// --- Identical re-capture must not re-send pixels. ---
const r1 = await rpc("tools/call", {
  name: "screenshot", arguments: { region: { x: 0, y: 0, width: 400, height: 200 } },
});
const r2 = await rpc("tools/call", {
  name: "screenshot", arguments: { region: { x: 0, y: 0, width: 400, height: 200 } },
});
const had1 = (r1.result?.content ?? []).some((c) => c.type === "image");
const had2 = (r2.result?.content ?? []).some((c) => c.type === "image");
check("unchanged region is not re-sent as an image", had1 && !had2,
  `first capture image=${had1}, second image=${had2}`);
const forced = await rpc("tools/call", {
  name: "screenshot",
  arguments: { region: { x: 0, y: 0, width: 400, height: 200 }, skipIfUnchanged: false },
});
check("skipIfUnchanged:false forces a fresh image",
  (forced.result?.content ?? []).some((c) => c.type === "image"));

console.log(fails.length ? `\n${fails.length} FAILURE(S): ${fails.join(", ")}` : "\nAll checks passed.");
proc.kill();
process.exit(fails.length ? 1 : 0);
