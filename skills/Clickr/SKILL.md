---
name: Clickr
description: Install or troubleshoot Clickr, the macOS screen-control MCP that lets Claude click, type and read any app. USE WHEN asked to install/set up/clone Clickr, when Clickr's tools are missing or misbehaving, or when a task needs a native macOS dialog and Clickr is not yet available.
---

# Clickr — install and troubleshooting

Clickr is an MCP server that drives any macOS app by screen coordinate: screenshot,
click, type, and read the screen as text.

**This skill covers installation only.** Once Clickr is installed, the MCP server ships
its own operating instructions — tool-choice ordering, the coordinate model, stale-
coordinate hazards, verification habits and the native-dialog recipe are all delivered
automatically to every session, and each tool carries its own detailed description. There
is nothing to remember from here about *using* it.

## Install

```bash
npm install -g @tekmidian/clickr && clickr install
```

Or from source, if the user wants a checkout they can run the tests from. Clone into a
directory they intend to keep — the registration points at it:

```bash
git clone https://github.com/mnott/Clickr.git
cd Clickr
npm install          # the prepare script builds the Swift helper and the TS server
node dist/cli.js install
```

`install` builds the native helper if missing, registers the MCP server in
`~/.claude.json` (backing that file up first), installs this skill, and prints permission
status. It is idempotent — running it again just updates the registration.

Do **not** use `npx`: the installer writes an absolute path to itself into
`~/.claude.json`, and it refuses to run from an npx cache because clearing that cache
would break the registration silently.

Then **tell the user to restart Claude Code.** The tools do not appear until they do, and
you cannot pick them up in your own session either.

## Requirements

macOS, Node 18+, and the Xcode Command Line Tools for `swiftc` (`xcode-select --install`).

## Permissions — explain this, it confuses people

Clickr needs **Accessibility** (to click and type) and **Screen Recording** (to capture
and to read window titles).

Both are granted to *the application that launches the MCP server* — the user's terminal,
or the Claude app — **not to Clickr**, which is why nothing called "Clickr" appears in
System Settings. They must grant them in System Settings → Privacy & Security and then
**fully quit and reopen** that application; a reload is not enough.

If a later `activate_app` prompts for **Automation**, that is the AppleScript activation
fallback and is expected.

## Other commands

| | |
|---|---|
| `clickr status` | what is registered, and which permissions are granted |
| `clickr doctor` | toolchain, helper, detected displays |
| `clickr uninstall` | remove the registration |

## Troubleshooting

- **Tools missing after install** — Claude Code was not restarted.
- **Clicks or typing do nothing** — Accessibility not granted, or the granting app was
  reloaded rather than fully quit and reopened. Check with the `check_permissions` tool.
- **Screenshots fail, or window titles come back empty** — Screen Recording not granted.
- **`swiftc` not found** — `xcode-select --install`.
- **Registration points at a path that no longer exists** — the checkout moved; re-run
  `clickr install` from its new location.
