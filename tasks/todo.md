## Continue

<!-- pai:checkpoint authored="model" session="0015 - 2026-08-13 - Token Grant Duration Refresh Bug, Build Setup" session-id="d0302abc-92eb-4cc4-8dc3-519fc005f39e" ts="2026-08-13T17:05:49.163Z" -->

> **Last session:** 0015 - 2026-08-13 - Token Grant Duration Refresh Bug, Build Setup
> **Paused at:** 2026-08-13T17:05:49.163Z
>
> Working directory: /Users/i052341/Daten/Cloud/Development/ai/clickr
>
> Resume with: `claude --resume d0302abc-92eb-4cc4-8dc3-519fc005f39e`

**Session focus:** made clickr's control-grant lapse window settable at handover time.
Everything below is uncommitted on `main`, on top of `a6d45d3`.

### Landed in the working tree (nothing committed, nothing published)

Grant window is now 30 minutes of idle by default and overridable per handover, capped at
24 hours:

- `src/controls.ts` — `ControlsState.minutes` persists the window on the grant;
  `normalizeGrantMinutes()` (clamp 1..1440), `formatGrantMinutes()`, `parseGrantDuration()`
  (anchored parse of "for 6 hours" / "6h" / "90m" / "an hour" / "für 6 Stunden", returning
  the remainder as the note). `refreshGrant()` no longer takes a `minutes` argument — it
  reads the window off the grant. `handoverMessage()` reports the real window, not a
  hardcoded 30.
- `src/hook.ts` — `lastHandover()` now returns the text after the phrase so the hook can
  parse an attached window; confirmation line names it.
- `src/cli.ts` — `clickr controls you for 6 hours` / `clickr controls you 6h <note>`;
  argv after the subcommand is rejoined and fed to the same parser as the spoken form.
  `controls status` prints the window. Usage text updated.
- `src/tools.ts` — `controls` tool gained a `minutes` parameter (+ description).
- `src/instructions.ts`, `README.md` — documented.
- `package.json` — new `test:controls` script.

### Verification done

- `npm run test:controls` (`scripts/controls-grant-test.mjs`, new): 39/39. Runs against a
  throwaway `HOME`, so it never touches `~/.local/state/clickr/controls.json` — confirmed
  that file still holds the lapsed 13:28 grant, unmodified.
- Regression proved by measurement, not assertion: compiled `controls.ts` as it stands at
  HEAD and ran the same sequence. Before: 6h grant → `refreshGrant()` → 30 min. After:
  360 → 360. Scratch harness at
  `<scratchpad>/prefix/{controls.ts,controls.js,run.mjs}` if it needs re-running.
- One genuine parser bug found and fixed during the test run: "and then quit" matched
  `an` + `d` and granted a day. Word-form amounts now require a whole word plus space.
- `npx tsc` clean. Native helper NOT rebuilt — no Swift touched, and instructions are
  served from TS (`src/index.ts` imports `INSTRUCTIONS`), not bundled into the binary.

### In flight / not done

- Nothing is committed, nothing published. `cpp` was not run and was not asked for.
- `npx tsc` wrote `dist/` in place, but the clickr MCP server process currently attached to
  this session was started before that and still has the old code loaded. The new behaviour
  needs a Claude Code restart to take effect for the running session. The `clickr` CLI and
  the `UserPromptSubmit` hook both spawn fresh and already use the new code.
- `npm run build` (native + tsc + `chmod +x dist/hook.js`) has not been run end to end
  this session; `dist/hook.js` is already executable from an earlier build.
- Pre-existing, untouched: `npm test` has 1 known environmental failure ("unchanged region
  is not re-sent as an image").

### Open items deliberately deferred

The operator said the older open points in `tasks/todo.md` can be covered later. The one
still genuinely open there is item 7: display/resolution churn silently invalidating
cached coordinates.

<!-- /pai:checkpoint -->

---
# Clickr — TODO

## 2026-08-13 — grant window is now settable

The control grant was a fixed 30-minute idle timer. It is now 30 minutes by default and
overridable at handover time: `your controls for 6 hours`, `clickr controls you for 6
hours`, or `minutes` on the `controls` tool. Capped at 24 hours.

The window is stored on the grant rather than recomputed, because `refreshGrant()` runs
after every actuating call — measured against a HEAD build, a 6-hour grant collapsed to
30 minutes on the agent's first click. Verified: `npm run test:controls`, 39 cases,
against a throwaway `HOME` so it never touches the real state file. Includes the
false-positive cases that matter ("your controls, open tab 3" must not read as a window).

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
2. ~~**Custom web UIs may expose nothing to the accessibility tree.**~~ **FIXED
   2026-08-03 — and the diagnosis in this item was wrong twice over.**
   The hypothesis was that the walk "stops at `AXWebArea`". It does not: `walkElements`
   is a plain BFS over `kAXChildrenAttribute` and never special-cases any role. And the
   page was not missing from the tree — measured on a live Chrome window, the page had
   **3472 reachable nodes** below the web area, untruncated.
   The real cause is **BFS order against `maxResults`**. A browser's toolbar, tab bar and
   menu bar sit *above* the page, so a search for a role the browser also uses for its
   own controls fills the cap with chrome and stops before reaching the page. Measured:
   `role: "AXButton"` under the defaults returned **40 elements, none of them in the
   page**. `role: "AXLink"` worked only because browser chrome has no links — which is
   why this looked like "some pages expose nothing" rather than a systematic ordering
   bug. `truncated: true` was set, but a bare boolean next to 40 plausible results is
   easy to read as "close enough".
   Fixed with `webContent: true` on `find_elements`: locates the `AXWebArea` roots with a
   shallow walk and starts the search there, skipping chrome instead of out-running it.
   Same query with the flag returns 40 genuine page controls. Truncation now also carries
   a `note` saying what to do, and the tool description no longer advises "filter harder
   rather than raising maxResults" — that advice caused the bug when the filter was a
   role the chrome shares.
   **Verified:** `scripts/webcontent-test.mjs` (`npm run test:webcontent`), 6 cases,
   including honest degradation (`webContent (none found)` on Finder) and a no-flag
   regression check. Skips cleanly when no browser is running. Read-only — `find_elements`
   posts no events.
3. ~~The README's MIT line landed after the 0.3.0 publish, so the tarball copy is one
   line behind.~~ **CLOSED** — went out with 0.4.0 on 2026-08-03.

**RESOLVED BY PAI 2026-08-03** — verified in their tree, not taken on trust. Commit
`de673b5` ("stop pai mcp/daemon install from wiping ~/.claude.json") lifted the logic
out of `mcp.ts` and `daemon.ts`, where it was duplicated, into `src/config/claude-json.ts`.
A missing file still yields `{}` (legitimate first run); malformed or unreadable now
throws instead of returning `{}`; writes back up to `~/.claude.json.bak-pai` and go
temp-file + rename so a crash cannot truncate. Both call sites import the shared module —
no residual `catch { return {} }` in either. `src/config/claude-json.test.ts` 6/6.
Original report, for context:

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

*Last updated: 2026-08-02T22:43:15.373Z*
