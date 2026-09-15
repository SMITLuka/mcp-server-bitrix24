import express from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { getEmployeeByApiKey, getEmployeeByBitrixUserId } from "./db.js";
import { buildMcpServer } from "./mcpServer.js";
import { createOauthRouter } from "./oauth.js";
import { createOidcProvider } from "./oidcProvider.js";
import { createInteractionRouter } from "./interactions.js";

async function authenticate(req, res, provider) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Missing or invalid token. Set Authorization: Bearer <token>." });
    return null;
  }

  // Legacy path: a static API key handed out by scripts/add-employee.js.
  const legacyEmployee = getEmployeeByApiKey(token);
  if (legacyEmployee) {
    if (!legacyEmployee.refresh_token) {
      res.status(403).json({
        error: `Bitrix24 account not linked yet. Visit ${config.baseUrl}/oauth/start?key=${legacyEmployee.api_key} to connect it.`,
      });
      return null;
    }
    return legacyEmployee;
  }

  // New path: an access token this server's own OIDC provider issued to a
  // Claude Custom Connector after the employee logged into Bitrix24.
  try {
    const accessToken = await provider.AccessToken.find(token);
    if (!accessToken?.accountId) {
      res.status(401).json({ error: "Invalid or expired token." });
      return null;
    }

    const employee = getEmployeeByBitrixUserId(accessToken.accountId);
    if (!employee?.refresh_token) {
      res.status(403).json({ error: "Bitrix24 account not linked for this token." });
      return null;
    }

    return employee;
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
    return null;
  }
}

async function main() {
  const provider = await createOidcProvider();

  const app = express();
  app.use(cors());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // MCP Authorization discovery: tells Claude (and other MCP clients) which
  // authorization server issues tokens for this resource.
  // https://modelcontextprotocol.io/specification/basic/authorization
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${config.baseUrl}/mcp`,
      authorization_servers: [config.baseUrl],
    });
  });

  // Handles /interaction/:uid — bounces the browser into Bitrix24 login.
  app.use(createInteractionRouter(provider));

  // oidc-provider's own routes: /auth, /token, /reg, /jwks,
  // /.well-known/openid-configuration, etc. Mounted before express.json()
  // because it parses bodies itself.
  app.use(provider.callback());

  app.use(express.json());
  app.use("/oauth", createOauthRouter(provider));

  // Stateless MCP endpoint: one transport per request, tools scoped to the authenticated employee.
  app.post("/mcp", async (req, res) => {
    const employee = await authenticate(req, res, provider);
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
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
