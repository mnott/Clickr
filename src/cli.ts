#!/usr/bin/env node
/**
 * clickr CLI — install, remove and diagnose the MCP server.
 *
 *   clickr install     register with Claude Code, build the helper, install the skill
 *   clickr uninstall   remove the registration (and optionally the skill)
 *   clickr status      show what is registered and which permissions are granted
 *   clickr doctor      diagnose a broken install
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatGrantMinutes,
  grantToAgent,
  normalizeGrantMinutes,
  parseGrantDuration,
  readControls,
  returnToUser,
} from "./controls.js";
import { readLastSteps } from "./steps.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const claudeJsonPath = join(homedir(), ".claude.json");
const skillDir = join(homedir(), ".claude", "skills", "Clickr");
const serverKey = "clickr";
const hookPath = join(packageRoot, "dist", "hook.js");

const c = {
  ok: (s: string) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s: string) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s: string) => `\x1b[33m!\x1b[0m ${s}`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function readConfig(): Record<string, any> {
  if (!existsSync(claudeJsonPath)) return {};
  try {
    return JSON.parse(readFileSync(claudeJsonPath, "utf8"));
  } catch (e: any) {
    throw new Error(
      `~/.claude.json is not valid JSON (${e.message}). Fix or move it, then retry.`
    );
  }
}

function writeConfig(config: Record<string, any>) {
  // This file holds the user's entire Claude Code configuration, so never write it
  // without a backup — a malformed write would cost them every MCP server they have.
  if (existsSync(claudeJsonPath)) {
    copyFileSync(claudeJsonPath, claudeJsonPath + ".bak-clickr");
  }
  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Registers dist/hook.js as a UserPromptSubmit hook so the operator's spoken "your
 * controls" / "my controls" is authoritative without the agent having to relay it.
 * Idempotent: re-running install must not add a second copy, and any hooks already
 * registered by other tools (for other events, or other UserPromptSubmit commands)
 * must survive untouched. Mutates `config` in place; returns whether it changed anything.
 */
function installHook(config: Record<string, any>): boolean {
  if (typeof config.hooks !== "object" || config.hooks === null) config.hooks = {};
  if (!Array.isArray(config.hooks.UserPromptSubmit)) config.hooks.UserPromptSubmit = [];
  const groups: any[] = config.hooks.UserPromptSubmit;

  const alreadyRegistered = groups.some(
    (g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => h?.command === hookPath)
  );
  if (alreadyRegistered) return false;

  groups.push({ matcher: "", hooks: [{ type: "command", command: hookPath }] });
  return true;
}

/**
 * Removes only clickr's UserPromptSubmit hook entry, leaving every other hook -- for
 * this or any other event -- exactly as it was. Mutates `config` in place; returns
 * whether it changed anything.
 */
function uninstallHook(config: Record<string, any>): boolean {
  const groups = config.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return false;

  let removed = false;
  const kept = groups
    .map((g) => {
      if (!Array.isArray(g?.hooks)) return g;
      const filteredHooks = g.hooks.filter((h: any) => h?.command !== hookPath);
      if (filteredHooks.length !== g.hooks.length) removed = true;
      return { ...g, hooks: filteredHooks };
    })
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);

  if (!removed) return false;

  config.hooks.UserPromptSubmit = kept;
  if (config.hooks.UserPromptSubmit.length === 0) delete config.hooks.UserPromptSubmit;
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  return true;
}

function helperBuilt(): boolean {
  return existsSync(join(packageRoot, "bin", "clickr-helper"));
}

function serverBuilt(): boolean {
  return existsSync(join(packageRoot, "dist", "index.js"));
}

function buildNative(): boolean {
  const script = join(packageRoot, "scripts", "build-native.sh");
  if (!existsSync(script)) {
    console.log(c.bad(`build script missing at ${script}`));
    return false;
  }
  const r = spawnSync("bash", [script], { stdio: "inherit" });
  return r.status === 0;
}

function permissions(): { accessibility: boolean; screenRecording: boolean } | null {
  const helper = join(packageRoot, "bin", "clickr-helper");
  if (!existsSync(helper)) return null;
  try {
    const out = execFileSync(helper, [], {
      input: JSON.stringify({ cmd: "permissions" }) + "\n",
      encoding: "utf8",
      timeout: 10_000,
    });
    const line = out.split("\n").find((l) => l.trim());
    const parsed = JSON.parse(line ?? "{}");
    return {
      accessibility: !!parsed.accessibility,
      screenRecording: !!parsed.screenRecording,
    };
  } catch {
    return null;
  }
}

function installSkill(): boolean {
  const source = join(packageRoot, "skills", "Clickr", "SKILL.md");
  if (!existsSync(source)) return false;
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(source, join(skillDir, "SKILL.md"));
  return true;
}

function reportPermissions() {
  const p = permissions();
  if (!p) {
    console.log(c.warn("could not query permissions (helper not built yet)"));
    return;
  }
  console.log(
    p.accessibility
      ? c.ok("Accessibility granted (click and type)")
      : c.bad("Accessibility DENIED — clicking and typing will fail")
  );
  console.log(
    p.screenRecording
      ? c.ok("Screen Recording granted (screenshots, window titles)")
      : c.bad("Screen Recording DENIED — screenshots will fail")
  );
  if (!p.accessibility || !p.screenRecording) {
    console.log();
    console.log(
      c.dim(
        "  These are granted to the app that LAUNCHES the MCP server — your terminal\n" +
          "  (iTerm2, Terminal) or the Claude app — not to clickr itself.\n" +
          "  System Settings > Privacy & Security > Accessibility / Screen Recording,\n" +
          "  then fully quit and reopen that application."
      )
    );
  }
}

function install() {
  console.log(c.bold("Installing clickr"));
  console.log();

  if (process.platform !== "darwin") {
    console.log(c.bad("clickr only works on macOS — it drives the macOS window server."));
    process.exit(1);
  }

  // The registration stores an absolute path to this package. An npx cache is not a
  // stable home for that — clearing the cache would break the registration silently,
  // long after the install appeared to succeed. Refuse rather than leave that trap.
  if (/[\\/](_npx|\.npm[\\/]_cacache)[\\/]/.test(packageRoot)) {
    console.log(c.bad("refusing to install from an npx cache directory."));
    console.log(c.dim(`  ${packageRoot}`));
    console.log();
    console.log("  clickr registers an absolute path to itself in ~/.claude.json, and this");
    console.log("  directory can be cleared at any time, which would break that silently.");
    console.log();
    console.log(c.bold("  Install globally instead:"));
    console.log("    npm install -g @tekmidian/clickr && clickr install");
    process.exit(1);
  }

  if (!helperBuilt()) {
    console.log("Building the native helper…");
    if (!buildNative()) {
      console.log(c.bad("native build failed. Install Xcode Command Line Tools:"));
      console.log(c.dim("  xcode-select --install"));
      process.exit(1);
    }
  }
  console.log(c.ok("native helper built"));

  if (!serverBuilt()) {
    console.log(c.bad(`dist/index.js is missing — run "npm run build" in ${packageRoot}`));
    process.exit(1);
  }
  console.log(c.ok("MCP server built"));

  const config = readConfig();
  if (typeof config.mcpServers !== "object" || config.mcpServers === null) {
    config.mcpServers = {};
  }
  const entry = {
    type: "stdio",
    command: "node",
    args: [join(packageRoot, "dist", "index.js")],
    description:
      "Screen measurement and input control for any macOS app: screenshot any display, " +
      "click any global coordinate, type into any UI element.",
  };
  const existed = !!config.mcpServers[serverKey];
  config.mcpServers[serverKey] = entry;
  const hookChanged = installHook(config);
  writeConfig(config);
  console.log(
    c.ok(`${existed ? "updated" : "registered"} "${serverKey}" in ~/.claude.json`)
  );
  if (existsSync(claudeJsonPath + ".bak-clickr")) {
    console.log(c.dim(`  backup: ${claudeJsonPath}.bak-clickr`));
  }
  console.log(
    hookChanged
      ? c.ok('registered the UserPromptSubmit hook -- "your controls" / "my controls" now work out loud')
      : c.dim("UserPromptSubmit hook already registered")
  );

  console.log(
    installSkill()
      ? c.ok(`skill installed to ${skillDir}`)
      : c.warn("skill file not found in package — skipping")
  );

  console.log();
  reportPermissions();
  console.log();
  console.log(c.bold("Restart Claude Code to pick up the new tools."));
}

function uninstall() {
  const config = readConfig();
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const serverRegistered = !!servers[serverKey];
  if (serverRegistered) delete servers[serverKey];
  const hookRemoved = uninstallHook(config);

  if (!serverRegistered && !hookRemoved) {
    console.log(c.warn(`"${serverKey}" was not registered in ~/.claude.json`));
    return;
  }

  writeConfig(config);
  console.log(
    serverRegistered
      ? c.ok(`removed "${serverKey}" from ~/.claude.json`)
      : c.dim(`"${serverKey}" mcp server was not registered`)
  );
  console.log(
    hookRemoved
      ? c.ok("removed the UserPromptSubmit hook")
      : c.dim("UserPromptSubmit hook was not registered")
  );
  console.log(c.dim(`  The skill at ${skillDir} was left in place; delete it manually if unwanted.`));
  console.log(c.bold("Restart Claude Code to drop the tools."));
}

function status() {
  console.log(c.bold("clickr status"));
  console.log();
  console.log(c.dim(`package: ${packageRoot}`));

  const servers = (readConfig().mcpServers ?? {}) as Record<string, any>;
  const entry = servers[serverKey];
  if (entry) {
    console.log(c.ok(`registered in ~/.claude.json -> ${(entry.args ?? []).join(" ")}`));
    const target = entry.args?.[0];
    if (target && !existsSync(target)) {
      console.log(c.bad(`  but that path does not exist — run "clickr install" again`));
    }
  } else {
    console.log(c.bad('not registered — run "clickr install"'));
  }

  console.log(helperBuilt() ? c.ok("native helper present") : c.bad("native helper missing"));
  console.log(serverBuilt() ? c.ok("dist/index.js present") : c.bad("dist/index.js missing"));
  console.log(
    existsSync(join(skillDir, "SKILL.md")) ? c.ok("skill installed") : c.warn("skill not installed")
  );
  console.log();
  reportPermissions();
}

function doctor() {
  status();
  console.log();
  console.log(c.bold("Toolchain"));
  const swiftc = spawnSync("which", ["swiftc"], { encoding: "utf8" });
  console.log(
    swiftc.status === 0
      ? c.ok(`swiftc: ${swiftc.stdout.trim()}`)
      : c.bad("swiftc missing — run: xcode-select --install")
  );
  console.log(c.ok(`node: ${process.version}`));

  if (helperBuilt()) {
    try {
      const helper = join(packageRoot, "bin", "clickr-helper");
      const out = execFileSync(helper, [], {
        input: JSON.stringify({ cmd: "displays" }) + "\n",
        encoding: "utf8",
        timeout: 10_000,
      });
      const parsed = JSON.parse(out.split("\n").find((l) => l.trim()) ?? "{}");
      const displays = parsed.displays ?? [];
      console.log(c.ok(`helper responds — ${displays.length} display(s) detected`));
      for (const d of displays) {
        console.log(
          c.dim(`    display ${d.index}: ${d.width}x${d.height} at (${d.x}, ${d.y})`)
        );
      }
    } catch (e: any) {
      console.log(c.bad(`helper did not respond: ${e.message}`));
    }
  }
}

/**
 * `rest` is everything after the subcommand, still as separate argv words. It may open
 * with a grant window ("for 6 hours", "6h") and continue with a free-text note, so the
 * words are rejoined and handed to the same parser the spoken form uses -- one syntax,
 * whether the operator says it to the agent or types it in a terminal.
 */
function controls(sub: string | undefined, rest: string[]) {
  const trailing = rest.join(" ").trim();
  switch (sub) {
    case "you": {
      const requested = parseGrantDuration(trailing);
      const note = (requested ? requested.rest : trailing) || undefined;
      const state = grantToAgent(note, requested?.minutes);
      console.log(
        c.ok(
          `controls handed to the agent — lapses after ` +
            `${formatGrantMinutes(normalizeGrantMinutes(state.minutes))} idle (${state.until})`
        )
      );
      if (note) console.log(c.dim(`  note: ${note}`));
      break;
    }
    case "me": {
      const note = trailing || undefined;
      const state = returnToUser(note);
      console.log(c.ok(`controls returned to the operator (${state.since})`));
      if (note) console.log(c.dim(`  note: ${note}`));
      break;
    }
    case undefined:
    case "status": {
      const state = readControls();
      console.log(c.bold("clickr controls"));
      console.log();
      console.log(`holder: ${state.holder === "agent" ? c.warn("agent") : c.ok("operator")}`);
      console.log(c.dim(`since:  ${state.since}`));
      if (state.until) console.log(c.dim(`until:  ${state.until}`));
      if (state.holder === "agent") {
        console.log(c.dim(`window: ${formatGrantMinutes(normalizeGrantMinutes(state.minutes))} idle`));
      }
      if (state.note) console.log(c.dim(`note:   ${state.note}`));
      break;
    }
    default:
      console.log(c.bad(`unknown "clickr controls ${sub}"`));
      console.log();
      console.log("  clickr controls you [for <n>] [note]  hand the controls to the agent");
      console.log("  clickr controls me [note]             return the controls to the operator");
      console.log("  clickr controls [status]              show who currently holds the controls");
      process.exit(1);
  }
}

function steps(nArg: string | undefined) {
  const parsed = nArg !== undefined ? parseInt(nArg, 10) : 20;
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  const lines = readLastSteps(n);
  if (!lines.length) {
    console.log(c.dim("no steps logged yet"));
    return;
  }
  /**
   * Rendered in the operator's own convention, and tolerant of both log shapes.
   *
   * An `outcome` column was added so a step that was begun and never finished
   * is distinguishable from one that completed — the case that used to leave no
   * trace at all. Lines written before that change have one field fewer, and
   * they are still worth reading, so the shape is detected per line rather than
   * assumed. A viewer that only understands today's format silently drops the
   * history it was built to show.
   */
  for (const line of lines) {
    const f = line.split("\t");
    const hasOutcome = f.length >= 5;
    const [iso, outcome, tool, step] = hasOutcome ? f : [f[0], "", f[1], f[2]];
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = Number.isNaN(d.getTime())
      ? iso
      : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const mark = outcome === "failed" ? c.dim("✗") : outcome === "start" ? c.dim("▸") : outcome === "ok" ? "✓" : " ";
    console.log(`[${stamp}] ${mark} ${c.dim(tool ?? "")}  ${step ?? ""}`);
  }
}

const command = process.argv[2];
try {
  switch (command) {
    case "install": install(); break;
    case "uninstall":
    case "remove": uninstall(); break;
    case "status": status(); break;
    case "doctor": doctor(); break;
    case "controls": controls(process.argv[3], process.argv.slice(4)); break;
    case "steps": steps(process.argv[3]); break;
    default:
      console.log("clickr — macOS screen measurement and input control for Claude Code");
      console.log();
      console.log("  clickr install                  build, register with Claude Code, install the skill");
      console.log("  clickr uninstall                remove the registration");
      console.log("  clickr status                   show registration and permission status");
      console.log("  clickr doctor                   diagnose a broken install");
      console.log("  clickr controls you [for <n>]   hand the controls to the agent (default 30 min idle)");
      console.log("  clickr controls me              return the controls to the operator");
      console.log("  clickr controls [status]        show who currently holds the controls");
      console.log("  clickr steps [n]                print the last n logged agent steps (default 20)");
      console.log();
      console.log(c.dim("  The MCP server itself is started by Claude Code, not by hand."));
      if (command) process.exit(1);
  }
} catch (e: any) {
  console.error(c.bad(e.message));
  process.exit(1);
}
