#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerParseTool } from "./tools/parse.js";
import { registerCreateTool } from "./tools/create.js";
import { registerValidateTool } from "./tools/validate.js";
import { registerModifyTool } from "./tools/modify.js";
import { registerAnalyzeTool } from "./tools/analyze.js";
import { registerConvertTool } from "./tools/convert.js";
import { registerFormatTool } from "./tools/format.js";

const server = new McpServer(
  {
    name: "mcp-bpmn",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register all BPMN tools
registerParseTool(server);
registerCreateTool(server);
registerValidateTool(server);
registerModifyTool(server);
registerAnalyzeTool(server);
registerConvertTool(server);
registerFormatTool(server);

// Start the server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BPMN MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
