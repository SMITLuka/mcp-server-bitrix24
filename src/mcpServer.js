import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerCrmTools } from "./tools/crm.js";

export function buildMcpServer(employeeId) {
  const server = new McpServer({ name: "bitrix24-mcp", version: "0.1.0" });

  registerTaskTools(server, employeeId);
  registerCrmTools(server, employeeId);

  return server;
}
