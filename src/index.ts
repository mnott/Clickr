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
      "All coordinates are GLOBAL POINTS: origin at the top-left of the main display, +y down. " +
      "Displays arranged left of or above the main display have negative coordinates, and any " +
      "number of displays is supported. The coordinates reported by screenshot, list_windows " +
      "and list_displays are the same ones click and drag accept.\n\n" +
      "Typical loop: list_displays or list_windows to find the target, screenshot (with " +
      "grid: true) to see and measure it, click to focus a field, then type_text. " +
      "When a target is small, screenshot a region of 1400 points or less around it — those " +
      "come back at exactly one image pixel per point, so measurement is exact.",
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
