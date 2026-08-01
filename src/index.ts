#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { helper } from "./helper.js";
import { INSTRUCTIONS } from "./instructions.js";
import { tools } from "./tools.js";

import { createRequire } from "node:module";
// Keep the advertised version in step with the package rather than hand-maintaining it.
const PKG_VERSION: string = createRequire(import.meta.url)("../package.json").version;

const server = new Server(
  { name: "clickr", version: PKG_VERSION },
  {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
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
