import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { getEmployeeByApiKey } from "./db.js";
import { buildMcpServer } from "./mcpServer.js";
import { oauthRouter } from "./oauth.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/oauth", oauthRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

function authenticate(req, res) {
  const authHeader = req.headers.authorization || "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const employee = apiKey && getEmployeeByApiKey(apiKey);

  if (!employee) {
    res.status(401).json({ error: "Missing or invalid API key. Set Authorization: Bearer <your key>." });
    return null;
  }

  if (!employee.refresh_token) {
    res.status(403).json({
      error: `Bitrix24 account not linked yet. Visit ${config.baseUrl}/oauth/start?key=${employee.api_key} to connect it.`,
    });
    return null;
  }

  return employee;
}

// Stateless MCP endpoint: one transport per request, tools scoped to the authenticated employee.
app.post("/mcp", async (req, res) => {
  const employee = authenticate(req, res);
  if (!employee) return;

  const server = buildMcpServer(employee.id);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed. This server runs in stateless mode (POST only)." });
});

app.listen(config.port, () => {
  console.log(`Bitrix24 MCP server listening on port ${config.port}`);
  console.log(`Public base URL: ${config.baseUrl}`);
});
