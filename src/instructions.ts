/**
 * Everything an agent needs to operate clickr correctly.
 *
 * This is the single source of truth for agent-facing guidance, and it ships inside
 * the MCP server itself so it reaches every session automatically — no skill to
 * install, no README to have read. The README is for humans deciding whether to use
 * clickr and how to install it; it deliberately does not repeat these rules.
 *
 * Per-tool detail lives in the individual tool descriptions instead of here, because
 * those are fetched on demand while this text is loaded in every session.
 */
export const INSTRUCTIONS = `clickr drives this Mac's screen and input devices directly: it captures any display region and posts real mouse and keyboard events, so it can operate any application without that application exposing a scripting interface.

## Choosing how to drive the computer

FIRST ASK: is the visible interaction itself what the user wants? If they asked to be shown something — "show me how to do a pivot table in Excel", "walk me through this dialog" — use clickr directly. Watching it happen is the deliverable, and doing it headlessly with a script misses the request entirely.

Otherwise the goal is the end state, so take as little of the user's machine as possible. The ordering below is NOT mainly about tokens; it is about whether the user can keep working. clickr moves the real pointer and types on the real keyboard, so for the duration the machine is yours, not theirs — and concurrent human input measurably causes dropped characters and misdirected clicks.

  1. A real API or CLI (gh, HTTP, writing a file). Headless, takes nothing from the user.
  2. macos-automator-mcp (mcp__macos_automator__execute_script) using an app's AppleScript/JXA DICTIONARY. The app works internally, the pointer never moves, and it addresses things by name so nothing goes stale when a window moves.
  3. The Chrome extension (mcp__claude-in-chrome__*) for anything in a web page. Costs the user only a browser tab, reads pages as text, and uses refs that survive reflow.
  4. clickr, and AppleScript UI SCRIPTING via System Events. Both seize pointer and keyboard.

Note the split within AppleScript: a dictionary script is tier 2 and free; System Events keystroke/click synthesises the same events clickr does and is tier 4. "It's AppleScript" does not mean non-invasive.

clickr's own niche is the native macOS Open/Save dialog — unreachable from a browser extension and not usefully scriptable — plus apps with no scripting dictionary: Electron, games, remote desktop, canvas UIs.

WHEN YOU DO TAKE OVER, TELL THE USER FIRST: roughly how long, and to keep hands off the mouse and keyboard until you say you are done. They cannot know otherwise, and their stray keystroke corrupts your work as surely as yours corrupts theirs.

## Coordinates

All coordinates are GLOBAL POINTS: origin at the top-left of the main display, +y down, in points rather than device pixels. Displays left of or above the main one have NEGATIVE coordinates, and any number of displays is supported. find_elements, list_windows, list_displays, screenshot and click all speak this same space, so a value from one goes straight into another.

## Prefer text over pixels

An image costs roughly (width*height)/750 tokens AND stays in the conversation, so it is re-sent on every later turn: 30 full-screen captures means ~54k tokens carried by every subsequent request, 120 means ~216k. Cost is cumulative, not per-screenshot, so a long run is dominated by captures taken near its start.

  - find_elements queries controls by role/title through the Accessibility API and returns exact click coordinates as TEXT. ~60ms, roughly a tenth the cost of a capture, and exact rather than eyeballed. Works on native apps and on web pages. Use it to locate anything.
  - read_text runs on-device OCR over a region and returns text only, no image. For canvas, video, remote desktop, or anything the accessibility tree cannot see.
  - click already reports the element it hit, so verifying a click rarely needs a capture.

IN A WEB PAGE OR AN ELECTRON APP, PASS webContent:true. The walk is breadth-first and the browser's own toolbar, tabs and menu bar sit above the page, so a search for a role the browser also uses — AXButton, AXGroup, AXTextField — spends the entire result cap on chrome before reaching the page. Measured on a live Chrome window: role AXButton under the defaults returned 40 elements, not one of them in the page, while the page held 3472 reachable nodes. The failure is indistinguishable from the page exposing nothing, which is exactly why it gets misdiagnosed. webContent:true starts at the page instead. Also check the \`truncated\` flag and the \`note\` that comes with it — a capped result is a partial answer wearing the costume of a complete one.

Caveat: a heavily custom web UI may still not expose its controls. If webContent:true reports 'webContent (none found)', or finds the area but not your control, fall back to screenshot and measure — but capture a tight region rather than a display. Regions up to 800 points come back at 1:1, one image pixel per point, which is the reliable way to measure precisely. Re-capturing an unchanged region returns a text note instead of a duplicate image.

## Stale coordinates are the main hazard

Treat a coordinate as valid ONLY for the state you measured it in. Three things invalidate one silently, and all three look identical when they happen — the click lands somewhere plausible and nothing errors:

  a. LAYOUT REFLOW — your own click inserts a toolbar and everything below shifts. The display layout is unchanged, so expectGeometry cannot see this. Guard it with expectRole/expectTitle on click and drag: clickr resolves what is actually under the point before posting the event and refuses on a mismatch. Pass them every time the coordinate came from find_elements — the role and title are right there in the result. That is a guard, not a licence to batch: still never batch coordinate clicks across a state-changing action, because a refusal costs a round-trip and re-querying is cheap.
  b. DISPLAY GEOMETRY CHANGE — a display sleeping or a VNC client reconnecting moves every window, at any moment. Carry the geometry token from list_displays or find_elements into click as expectGeometry, and a mismatch refuses the action instead of clicking whatever moved underneath.
  c. OCCLUSION — a window capture composites the target unobstructed, so a coordinate read off it can hit whatever is really on top. screenshot warns when this applies.

## Verify, and prefer certainty over identification

VERIFY EVERY STATE-CHANGING CLICK. click returns hitElement describing what it actually hit, and find_elements costs ~385 tokens, so verification no longer needs a ~2000-token screenshot. Check the result of anything that selects, deletes, publishes or otherwise changes state. Batching clicks and hoping was a rational response to expensive verification and no longer is.

TAKE THE DIRECT LINK WHEN THE APP OFFERS ONE. After creating something, apps offer a route straight to it — "View post", "Show in Finder", "Open", "Go to record". Follow it rather than dismissing the dialog and hunting for the object in a list. Navigating directly means you are acting on the thing you just created, by construction; finding it in a list means identifying the right row among near-identical ones, and picking the wrong row is the most damaging mistake available in UI automation.

## Typing

Keyboard events go to whatever app is FRONTMOST, and a synthetic click does NOT activate the app it lands on — so always pass \`app\` to type_text and press_key. The tool descriptions explain the rest, including when keystrokes arrive scrambled and paste is required.

## Recipe: a file upload through the native Open dialog

This is clickr's core use case, and it needs no screenshots.

  1. Trigger the file picker in the page (Chrome extension, by ref).
  2. press_key "g" with ["cmd","shift"] — opens "Go to folder".
  3. type_text the ABSOLUTE path with method:"paste", then press_key "return".
  4. find_elements with role:"AXButton", titleContains:"Open" → click its centerX/centerY.
  5. Control returns to the page; go back to the Chrome extension.

If you need to confirm the dialog state, find_elements with role:"AXTextField" — the Go-to-folder field is the one with focused:true.`;
