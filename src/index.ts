#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { helper } from "./helper.js";
import { tools } from "./tools.js";

const server = new Server(
  { name: "clickr", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "clickr drives this Mac's screen and input devices directly: it captures any display " +
      "region and posts real mouse and keyboard events, so it can operate any application " +
      "without that application exposing a scripting interface.\n\n" +
      "USE IT AS A FALLBACK, NOT A DEFAULT. In order of preference:\n" +
      "  1. A real API or CLI (gh, HTTP, writing a file) — most reliable.\n" +
      "  2. The Chrome extension (mcp__claude-in-chrome__*) for anything inside a web page. " +
      "It is cheaper AND more correct: it reads pages as text, and addresses elements by ref, " +
      "which stays bound even when the page reflows.\n" +
      "  3. macos-automator-mcp (mcp__macos_automator__execute_script) for any app with an " +
      "AppleScript/JXA dictionary — Finder, Mail, Safari, Terminal and most established Mac " +
      "apps. It addresses things by name rather than coordinate, so nothing it does goes " +
      "stale when a window moves; strictly more reliable than clickr wherever it applies.\n" +
      "  4. clickr, for what none of the above can touch — above all the native macOS " +
      "Open/Save dialog, which a browser extension cannot cross into and which is not " +
      "usefully scriptable, plus apps with no scripting dictionary (Electron, games, " +
      "remote desktop, canvas UIs).\n\n" +
      "PREFER TEXT OVER PIXELS. A screenshot costs about (width*height)/750 tokens and stays " +
      "in the conversation, so it is re-sent every later turn; 30 full-screen captures means " +
      "~54k tokens carried by every subsequent request. Use find_elements to locate controls " +
      "by role/title and get exact click coordinates as text (~10x cheaper and exact), " +
      "read_text for on-device OCR with no image, and note that click already reports the " +
      "element it hit so verification rarely needs a capture.\n\n" +
      "COORDINATES ARE GLOBAL POINTS: origin at the top-left of the main display, +y down. " +
      "Displays left of or above the main display have negative coordinates, and any number " +
      "of displays is supported. find_elements, list_windows, list_displays, screenshot and " +
      "click all speak this same space.\n\n" +
      "STALE COORDINATES ARE THE MAIN HAZARD — treat a coordinate as valid only for the " +
      "state you measured it in. Three things invalidate one silently, and all three look " +
      "identical when they happen (the click lands somewhere plausible and nothing errors): " +
      "(a) layout reflow — your own click inserts a toolbar and everything below shifts, " +
      "which is self-inflicted and fully avoidable: NEVER batch coordinate clicks across a " +
      "state-changing action; (b) a display resolution change moving every window, which is " +
      "external and can strike at any moment — carry the `geometry` token from list_displays " +
      "or find_elements into click as expectGeometry and a mismatch refuses the action; " +
      "(c) capturing an occluded window, where the image shows it unobstructed but the click " +
      "hits whatever is on top — screenshot warns about this.\n\n" +
      "VERIFY EVERY STATE-CHANGING CLICK. click returns hitElement describing what it " +
      "actually hit, and find_elements costs ~385 tokens, so verification no longer needs a " +
      "~2000-token screenshot. Check the result of anything that selects, deletes, publishes " +
      "or otherwise changes state — batching clicks and hoping was a rational response to " +
      "expensive verification and no longer is.\n\n" +
      "Typing goes to whatever app is frontmost, and a synthetic click does not activate the " +
      "app it lands on — always pass `app` to type_text and press_key so it activates the " +
      "target and refuses to type anywhere else. Use method:'paste' for any field with " +
      "autocomplete or an IME (URL bars, search boxes, file paths): such fields reorder " +
      "characters between keystrokes and typed text arrives scrambled.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const content = await tool.handler((request.params.arguments ?? {}) as Record<string, any>);
    return { content };
  } catch (e: any) {
    return {
      isError: true,
      content: [{ type: "text", text: e?.message ?? String(e) }],
    };
  }
});

const shutdown = () => {
  helper.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
