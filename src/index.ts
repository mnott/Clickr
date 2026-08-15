#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ACTUATING_TOOLS, handoverMessage, readControls, refreshGrant } from "./controls.js";
import { helper } from "./helper.js";
import { INSTRUCTIONS } from "./instructions.js";
import { announcement, logStep } from "./steps.js";
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

// Actuating tools carry an extra required `step` argument, injected here rather than
// hand-written into all nine schemas so the requirement can't drift out of sync with
// ACTUATING_TOOLS. Built as new objects -- the shared `tools` array entries are never
// mutated, since ListTools can be called many times and tool.inputSchema is also used
// as-is elsewhere (e.g. by the gate below).
const STEP_PROPERTY = {
  type: "string",
  description:
    "One short plain-English sentence describing what this step is about to do and why. " +
    "Required for every actuating call; shown to the operator alongside the result and " +
    "recorded in the step log.",
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => {
    if (!ACTUATING_TOOLS.has(name)) {
      return { name, description, inputSchema };
    }
    const schema = inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      [key: string]: unknown;
    };
    const properties = { ...(schema.properties ?? {}), step: STEP_PROPERTY };
    const required = Array.from(new Set([...(schema.required ?? []), "step"]));
    return {
      name,
      description,
      inputSchema: { ...schema, properties, required },
    };
  }),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }

  const rawArgs = (request.params.arguments ?? {}) as Record<string, any>;
  const actuating = ACTUATING_TOOLS.has(tool.name);

  if (actuating) {
    // Fresh read on every call, deliberately uncached -- see controls.ts. This is what
    // lets `clickr controls me` in another terminal take effect at the very next call,
    // mid-sequence.
    if (readControls().holder !== "agent") {
      return { isError: true, content: [{ type: "text", text: handoverMessage() }] };
    }
    if (typeof rawArgs.step !== "string" || rawArgs.step.trim() === "") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `"${tool.name}" requires a "step" argument: one short plain-English sentence ` +
              "describing what this step is about to do and why. Include it and retry.",
          },
        ],
      };
    }
  }

  // Strip `step` before it reaches the native helper, which knows nothing about it.
  const { step, ...args } = rawArgs;

  /**
   * SAY IT BEFORE DOING IT.
   *
   * The announcement used to be produced only after the handler returned, which
   * made it a report rather than a warning: a call that hung, froze the screen
   * or never came back left no trace of what it had been about to do — the one
   * situation where the operator most needs to know. It is now written to the
   * step log and to stderr before the pointer moves.
   *
   * It is also formatted in the operator's own convention rather than a private
   * one. That convention used to be a standing instruction the model was asked
   * to type by hand every time, and a rule that depends on remembering is a rule
   * that decays — it went missing repeatedly. Emitting it here makes it
   * structural: there is no way to actuate without it, because `step` is already
   * required and this is what happens to it.
   */
  const note = actuating ? announcement(String(step)) : null;
  if (note) {
    logStep(tool.name, String(step), args, "start");
    // stderr, not stdout: stdout is the MCP transport and anything written
    // there corrupts the protocol. stderr reaches the operator's server log.
    try { process.stderr.write(`${note}\n`); } catch { /* never block a call */ }
  }

  try {
    const content = await tool.handler(args);
    if (actuating) {
      // Only a successful actuating call keeps the grant alive -- a refused or
      // failed call should not extend control it didn't get to use.
      refreshGrant();
      logStep(tool.name, String(step), args, "ok");
      return { content: [{ type: "text", text: note! }, ...content] };
    }
    return { content };
  } catch (e: any) {
    // A failed actuation is exactly what the pre-log exists for: the intent is
    // already on record, and this closes it rather than leaving it dangling.
    if (actuating) logStep(tool.name, String(step), args, "failed");
    return {
      isError: true,
      content: [
        ...(note ? [{ type: "text" as const, text: note }] : []),
        { type: "text" as const, text: e?.message ?? String(e) },
      ],
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
