// Without the INTEGRATION_HUB_* env vars the server must behave exactly as before this feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
Object.assign(process.env, {
  BASE_URL: "https://mcp.example.test",
  BITRIX_DOMAIN: "crm.example.test",
  BITRIX_CLIENT_ID: "test-client",
  BITRIX_CLIENT_SECRET: "test-secret",
  DB_PATH: join(dir, "mcp.sqlite"),
  JWKS_PATH: join(dir, "jwks.json"),
});
delete process.env.INTEGRATION_HUB_API_URL;
delete process.env.INTEGRATION_HUB_REDIRECT_URIS;

const { createOidcProvider, integrationHubClients, defaultResource, resourceServerInfo } = await import("../src/oidcProvider.js");
const claude = { clientId: "dcr-registered-claude-client" };

test("provider starts and has no static clients", async () => {
  const provider = await createOidcProvider();
  assert.deepEqual(integrationHubClients(), []);
  assert.equal(await provider.Client.find("integration-hub"), undefined);
});

test("MCP resource is unchanged: default resource and opaque bitrix24 token", () => {
  assert.equal(defaultResource({}, claude), "https://mcp.example.test/mcp");
  assert.deepEqual(resourceServerInfo({}, "https://mcp.example.test/mcp", claude), { scope: "bitrix24", accessTokenFormat: "opaque" });
});

test("any other resource is rejected", () => {
  assert.throws(() => resourceServerInfo({}, "https://api.example.test", claude), { name: "InvalidTarget" });
});
