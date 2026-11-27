// Skills over MCP: initialize, resources/list+read, prompts/list+get over real stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const skill = readFileSync("skills/Clickr/SKILL.md", "utf8");
const client = new Client({ name: "skill-test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const fails = [];
const check = (l, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) fails.push(l); };

const caps = client.getServerCapabilities();
check("capabilities resources+prompts", !!caps.resources && !!caps.prompts);
const ins = client.getInstructions() ?? "";
check("instructions names resource", ins.includes("skill://clickr/SKILL.md"));
check("instructions names prompt", ins.includes("clickr-skill"));
check("instructions short", ins.length < 2500);
const { resources } = await client.listResources();
const r = resources.find((x) => x.uri === "skill://clickr/SKILL.md");
check("resources/list", !!r && r.mimeType === "text/markdown");
const rd = await client.readResource({ uri: "skill://clickr/SKILL.md" });
check("resources/read == SKILL.md", rd.contents[0].text === skill && rd.contents[0].mimeType === "text/markdown");
const { prompts } = await client.listPrompts();
check("prompts/list", prompts.some((p) => p.name === "clickr-skill"));
const pg = await client.getPrompt({ name: "clickr-skill" });
check("prompts/get == SKILL.md", pg.messages[0].content.text === skill);
await client.close();
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
