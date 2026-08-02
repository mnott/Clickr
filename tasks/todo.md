## Continue

<!-- pai:checkpoint authored="auto" session="0012 - 2026-08-02 - Shared Persistence Layer Via Json Store" session-id="0074c449-ce84-4ccd-a66d-57dc61b25ea5" ts="2026-08-02T22:12:29.679Z" -->

> **Last session:** 0012 - 2026-08-02 - Shared Persistence Layer Via Json Store
> **Paused at:** 2026-08-02T22:12:29.679Z
>
> Working directory: /Users/i052341/Daten/Cloud/Development/ai/clickr
>
> Resume with: `claude --resume 0074c449-ce84-4ccd-a66d-57dc61b25ea5`

_Automatic checkpoint — 2026-08-02T22:12:29.617Z. Written without the model, from the transcript and the working tree. A model-authored checkpoint replaces this; it is here so an interrupted session still leaves something._

### What was being asked

- I don't see anything running, so I assume it is done?

### Working tree

- Branch: `main`
- HEAD: b66c7d9 docs: session checkpoint and remaining open items
- 6 uncommitted path(s):

```
M native/clickr-helper.swift
 M package.json
 M src/instructions.ts
 M src/tools.ts
 M tasks/todo.md
?? scripts/reflow-guard-test.mjs
```

<!-- /pai:checkpoint -->

---
# Clickr — TODO

## Continue (state at 2026-08-01)

Shipped and published: `@tekmidian/clickr@0.3.0` on npm, https://github.com/mnott/Clickr.
MIT. Registered in `~/.claude.json`; skill installed to `~/.claude/skills/Clickr/`.

**Open:**

1. ~~**Page reflow has no automatic guard.**~~ **FIXED 2026-08-02** — and the old verdict
   ("possibly unfixable from clickr's side") was wrong. `geometryToken()` is derived
   purely from `displayList()` (id, origin, size, scale), so in-window reflow is
   invisible to it by construction — that part was right. But `doClick` already called
   `elementAtPoint(point)` *after* posting the event, to report `hitElement`. The same
   call placed *before* the event turns a post-hoc description into a guard.
   Shipped as opt-in `expectRole` / `expectTitle` on `click` and `drag`: clickr resolves
   what is actually under the point and refuses on a mismatch. Opt-in because clickr's
   niche (canvas, games, remote desktop) has no accessibility tree to assert against —
   with no expectation passed, behaviour is byte-identical to before.
   Not wired into `move_mouse` or `scroll`: neither can destroy state, and the failure
   this came from was a click that deselected a file.
   **Verified:** `scripts/reflow-guard-test.mjs` (`npm run test:reflow`), 7 cases. Against
   a pre-fix binary rebuilt from HEAD, the two refusal cases fail — the click returns
   `ok: true` with `hitElement.role: "AXWindow"` despite `expectRole: "AXCheckBox"`.
   Against the fix, 7/7. Every click it posts is aimed at a window title bar, so the test
   cannot alter app state.
   `npm test` shows 1 failure ("unchanged region is not re-sent as an image") that is
   **pre-existing** — reproduced on a clean baseline. Environmental: it captures
   (0,0,400,200), a live terminal repainting between the two captures. Still open, and
   not worth chasing without a stable capture target.
   **Shipped in 0.4.0** (`ae1f51b`), published to npm 2026-08-03.
2. **Custom web UIs may expose nothing to the accessibility tree.** LinkedIn's composer
   footer returned zero from `find_elements` and resolved only to the containing
   `AXWebArea`, forcing screenshot-and-measure. Worth checking whether a different AX
   traversal (e.g. not stopping at `AXWebArea`) would reach those controls.
3. ~~The README's MIT line landed after the 0.3.0 publish, so the tarball copy is one
   line behind.~~ **CLOSED** — went out with 0.4.0 on 2026-08-03.

**Handed to PAI, awaiting their side:** a data-loss bug in PAI's `mcp.ts` —
`readClaudeJson()` returns `{}` on a parse error and `writeClaudeJson()` then overwrites,
so a malformed `~/.claude.json` would be replaced with a config containing only the `pai`
entry. Also asked PAI to check AIBroker for the same pattern. Clickr guards this by
throwing on unparseable config and backing up before every write.

**AIBroker checked 2026-08-02:** it never writes `~/.claude.json`, so the exact bug does
not apply, and the general pattern was already fixed in `89ee3ce` (`core/json-store.ts`
treats "unreadable" as distinct from "empty", blocks writes, atomic + `.bak`). Two
residual call sites remain on the old shape — `voice-config.json` and `sessions.json` in
`core/persistence.ts`, via its local `safeReadJson`/`safeWriteJson`.

**Fixed the same day:** those helpers now sit on `json-store`'s `loadJson`/`saveJson` — an
unparseable file blocks writes (per file, sticky, cleared by a good read or `setAppDir`)
and every write is atomic with a `.bak`. New `test/persistence.test.ts` pins it: 3 of its
7 tests fail against the pre-fix file, all 7 pass after; suite 483/483. Left uncommitted
in the AIBroker tree. Nothing further owed on the clickr side.


## RESOLVED 2026-08-01 — root cause measured, fixes implemented

The compounding mechanism is **image accumulation in context**, not MCP call overhead.

Vision tokens ≈ `width * height / 750`. The old default (`maxDimension` 1400) produced
~1400x965 ≈ **1801 tokens** for a full display. The decisive part: **images persist in the
conversation and are re-sent on every subsequent turn**, so cost is cumulative, not per-shot:

| screenshots @1400 | tokens resident in EVERY later turn |
|---|---|
| 10 | 18k |
| 30 | 54k |
| 60 | 108k |
| 120 | 216k |

~51 uploads at 2-3 captures each ≈ 100-150 images ≈ **180-270k tokens carried per turn** by
the end of the run. That explains "1% per roundtrip", and why it grew through the night.

The caveat below still stands: a text-only turn also showed ~1%, so there is separate
per-turn overhead (hooks, SessionStart payloads, large MCP schemas). Both can be true.

**Shipped:**
1. Default `maxDimension` 1400 -> 800 (1801 -> 588 tokens, ~3x).
2. **Content-hash dedup** — re-capturing an unchanged region returns *text* instead of a
   second identical image. The first image is still in context, so re-sending is pure waste.
   Kills polling loops ("did it save yet?").
3. **`find_elements` / `element_at`** via the Accessibility API — query controls by
   role/title and get exact click coordinates as text. The structural fix (item 3 below).
4. `click` returns the AX element it hit (item 4 below).
5. `screenshot` description now states the token-cost rule (item 5 below).

**Item 6 was not a bug.** `screencapture -l` composites the window *unoccluded*, so it can
show content that is actually hidden behind another window. Coordinates are correct, but a
click there hits whatever is on top — exactly the "click missed, deselected a file" symptom.
Clickr now warns when a captured window is occluded.

Item 7 (display churn invalidating coordinates) is still open.

---

## Original analysis (raised 2026-08-01, from the YouTube migration session)

**Context:** drove ~51 YouTube uploads end-to-end via clickr (Studio UI + the native
macOS Open dialog). Worked correctly, but consumed a lot of tokens. Screenshots are
returned as images and billed as vision tokens at roughly `width * height / 750`:

| capture                | tokens |
|------------------------|--------|
| 1210x1250 (full list)  | ~2,000 |
| 1400x965 (full display)| ~1,800 |
| 900x250 (small strip)  | ~300   |

Caveat worth stating honestly: it is NOT yet proven that clickr was the dominant cost in
that session. A text-only turn also showed ~1% usage, which suggests significant per-turn
overhead elsewhere (hooks injecting context on every prompt, large MCP tool schemas,
SessionStart payloads). Matthias is investigating separately. Treat the items below as
"clickr can be cheaper regardless", not as a confirmed root cause.

### Ideas for clickr itself

1. **Default `maxDimension` lower than 1400.**
   The schema already says "Lower it to save tokens" — but the default (1400) is the
   expensive one, so callers pay maximum unless they know to opt out. Consider defaulting
   to ~800, or auto-scaling: if the requested region is only being used to read a label
   or confirm a radio state, full resolution is wasted.

2. **A text-only observation mode.**
   Biggest single win. Something like `describe_region` / `read_text(region)` returning
   OCR'd text or the AX tree as *text* instead of an image. Most of my screenshots existed
   only to answer "is this radio selected?" / "did the title save?" — questions with a
   one-line textual answer. `list_windows` already proves the pattern: geometry as text,
   ~100 tokens, no image.

3. **AX-based element query.**
   `find_element(app, role, title)` -> returns coordinates. Pixel-hunting forces a
   screenshot before *every* click; a selector-style lookup would remove most captures
   entirely. This is the structural fix — the others are mitigations.

4. **Return click verification in the click result.**
   `click` already returns `clickedWindow`. If it could also return the AX element hit
   (role/title/state), most post-click verification screenshots disappear.

5. **Docs / tool-description guidance.**
   Add an explicit "token cost" note to `screenshot`: state the ~w*h/750 rule and
   recommend `maxDimension` + tight regions. Agents optimise for what the schema tells them.

### Two real bugs I hit that cost extra round-trips

6. **`window:` capture returns wrong mapping metadata.**
   `screenshot(window: <id>)` returned an image of the *whole desktop* while reporting
   the region as the window's bounds. Coordinates computed from it were wrong and my
   click missed (deselected a file in an Open dialog). `display:` and explicit `region:`
   are exact. Either fix the capture or the reported mapping.

7. **Display/resolution churn silently invalidates coordinates.**
   During the run the display went 2560x1440 -> 1920x1080 -> 2420x1668 -> 1512x1042
   (external display off, then VNC from an iPad renegotiating). Windows migrated and every
   cached coordinate broke mid-sequence; one queued click landed on the wrong app.
   Would be useful: a `geometry_token` / generation counter that `click` can be checked
   against, so a stale coordinate fails loudly instead of clicking the wrong thing.

### Non-clickr gotcha worth documenting somewhere

8. macOS SMB mounts return filenames in **NFD**; CSV/JSON usually store **NFC**. Any
   filename comparison across `/Volumes/...` needs `unicodedata.normalize('NFC', ...)`
   on both sides, or every name containing é/à looks like a mismatch.
   (Also: `sha256sum *.mp4` breaks when a filename starts with `-` — use
   `find . -name '*.mp4' -print0 | xargs -0 sha256sum`.)

---

*Last updated: 2026-08-02T22:08:06.532Z*
