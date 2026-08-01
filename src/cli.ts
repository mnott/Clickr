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

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const claudeJsonPath = join(homedir(), ".claude.json");
const skillDir = join(homedir(), ".claude", "skills", "Clickr");
const serverKey = "clickr";

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
  writeConfig(config);
  console.log(
    c.ok(`${existed ? "updated" : "registered"} "${serverKey}" in ~/.claude.json`)
  );
  if (existsSync(claudeJsonPath + ".bak-clickr")) {
    console.log(c.dim(`  backup: ${claudeJsonPath}.bak-clickr`));
  }

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
  if (!servers[serverKey]) {
    console.log(c.warn(`"${serverKey}" was not registered in ~/.claude.json`));
    return;
  }
  delete servers[serverKey];
  writeConfig(config);
  console.log(c.ok(`removed "${serverKey}" from ~/.claude.json`));
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

const command = process.argv[2];
try {
  switch (command) {
    case "install": install(); break;
    case "uninstall":
    case "remove": uninstall(); break;
    case "status": status(); break;
    case "doctor": doctor(); break;
    default:
      console.log("clickr — macOS screen measurement and input control for Claude Code");
      console.log();
      console.log("  clickr install     build, register with Claude Code, install the skill");
      console.log("  clickr uninstall   remove the registration");
      console.log("  clickr status      show registration and permission status");
      console.log("  clickr doctor      diagnose a broken install");
      console.log();
      console.log(c.dim("  The MCP server itself is started by Claude Code, not by hand."));
      if (command) process.exit(1);
  }
} catch (e: any) {
  console.error(c.bad(e.message));
  process.exit(1);
}
