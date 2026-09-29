// With INTEGRATION_HUB_* set, Claude's MCP resource must stay exactly as before and only the
// Integration Hub client may obtain JWTs for the Integration Hub API.
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
  INTEGRATION_HUB_API_URL: "https://api.example.test",
  INTEGRATION_HUB_REDIRECT_URIS: "https://hub.example.test/, http://localhost:4200/",
});

const { createOidcProvider, defaultResource, resourceServerInfo } = await import("../src/oidcProvider.js");
const claude = { clientId: "dcr-registered-claude-client" };
const hub = { clientId: "integration-hub" };

test("provider starts and registers the integration-hub public client", async () => {
  const provider = await createOidcProvider();
  const client = await provider.Client.find("integration-hub");
  assert.ok(client);
  assert.equal(client.tokenEndpointAuthMethod, "none");
  assert.deepEqual(client.redirectUris, ["https://hub.example.test/", "http://localhost:4200/"]);
});

test("Claude keeps the MCP resource with opaque bitrix24 tokens", () => {
  assert.equal(defaultResource({}, claude), "https://mcp.example.test/mcp");
  assert.deepEqual(resourceServerInfo({}, "https://mcp.example.test/mcp", claude), { scope: "bitrix24", accessTokenFormat: "opaque" });
});

test("Claude cannot obtain Integration Hub tokens", () => {
  assert.throws(() => resourceServerInfo({}, "https://api.example.test", claude), { name: "InvalidTarget" });
});

test("Integration Hub gets JWTs for its own API, audience bound to it", () => {
  assert.equal(defaultResource({}, hub), "https://api.example.test");
  const info = resourceServerInfo({}, "https://api.example.test", hub);
  assert.equal(info.accessTokenFormat, "jwt");
  assert.equal(info.audience, "https://api.example.test");
  assert.equal(info.scope, "integration-hub");
});

test("Integration Hub cannot obtain MCP (Bitrix tools) tokens", () => {
  assert.throws(() => resourceServerInfo({}, "https://mcp.example.test/mcp", hub), { name: "InvalidTarget" });
});
