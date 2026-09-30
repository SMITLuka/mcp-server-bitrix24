// End-to-end login flow through the real routes (/auth, /interaction, /oauth/callback, consent,
// /token) for both relying parties. Only the two Bitrix24 HTTP calls are stubbed (token exchange
// and user.current), so this verifies that Claude's MCP login still yields an opaque /mcp token and
// that Integration Hub gets an at+jwt JWT bound to its own API with the Bitrix user type claim.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "mcp-flow-"));
Object.assign(process.env, {
  BASE_URL: baseUrl,
  BITRIX_DOMAIN: "crm.example.test",
  BITRIX_CLIENT_ID: "test-client",
  BITRIX_CLIENT_SECRET: "test-secret",
  DB_PATH: join(dir, "mcp.sqlite"),
  JWKS_PATH: join(dir, "jwks.json"),
  INTEGRATION_HUB_API_URL: "https://api.example.test",
  INTEGRATION_HUB_REDIRECT_URIS: "http://localhost:4200/",
});

// Stub Bitrix24: code exchange (axios.get to oauth.bitrix.info) and REST user.current (axios.post).
const { default: axios } = await import("axios");
axios.get = async () => ({ data: { access_token: "bx-access", refresh_token: "bx-refresh", expires_in: 3600 } });
let workgroupLookupFails = false;
axios.post = async (url) => {
  if (url.endsWith("/rest/user.current.json")) {
    return { data: { result: { ID: "7", NAME: "Luka", LAST_NAME: "Lozic", EMAIL: "luka@example.test", USER_TYPE: "employee", UF_DEPARTMENT: [1] } } };
  }
  if (url.endsWith("/rest/sonet_group.user.groups.json")) {
    if (workgroupLookupFails) throw new Error("insufficient_scope");
    return {
      data: {
        result: [
          { GROUP_ID: "45", GROUP_NAME: "CDP razvoj", ROLE: "K" },
          { GROUP_ID: 42, GROUP_NAME: "Pantheon programiranje", ROLE: "A" },
          { GROUP_ID: "99", GROUP_NAME: "Only requested to join", ROLE: "Z" },
          { GROUP_ID: "98", GROUP_NAME: "Banned", ROLE: "T" },
        ],
        total: 4,
      },
    };
  }
  throw new Error(`unexpected Bitrix call ${url}`);
};

const { default: express } = await import("express");
const { createOidcProvider } = await import("../src/oidcProvider.js");
const { createOauthRouter } = await import("../src/oauth.js");
const { createInteractionRouter } = await import("../src/interactions.js");

let server;
before(async () => {
  const provider = await createOidcProvider();
  const app = express();
  app.use(createInteractionRouter(provider));
  app.use("/oauth", createOauthRouter(provider));
  app.use(provider.callback());
  await new Promise((resolve) => (server = app.listen(port, "127.0.0.1", resolve)));
});
after(() => server.close());

// Minimal browser: follows redirects manually and keeps cookies by name.
function browser() {
  const jar = new Map();
  return async function go(url, init = {}) {
    const headers = { ...(init.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    const res = await fetch(new URL(url, baseUrl), { ...init, headers, redirect: "manual" });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const idx = pair.indexOf("=");
      jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    return res;
  };
}

// Drives /auth until the client's redirect_uri receives a code, answering the Bitrix login step
// the way crm.sm-it.hr would (redirect back to /oauth/callback with a code and the same state).
async function loginAndGetCode(go, authParams, redirectUri) {
  let location = `/auth?${new URLSearchParams(authParams)}`;
  for (let hops = 0; hops < 15; hops++) {
    if (location.startsWith("https://crm.example.test/oauth/authorize/")) {
      const state = new URL(location).searchParams.get("state");
      location = `/oauth/callback?code=bitrix-code&state=${encodeURIComponent(state)}`;
    }
    if (location.startsWith(redirectUri)) {
      const params = new URL(location).searchParams;
      assert.equal(params.get("error"), null, `authorization error: ${params.get("error_description")}`);
      return params.get("code");
    }
    const res = await go(location);
    assert.ok([302, 303].includes(res.status), `unexpected ${res.status} at ${location}: ${await res.text()}`);
    location = res.headers.get("location");
  }
  throw new Error("too many redirects");
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function exchange(go, body) {
  const res = await go("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

function decodeJwt(token) {
  const [header, payload] = token.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url")));
  return { header, payload };
}

test("Integration Hub login yields an at+jwt access token for its API with the Bitrix user type", async () => {
  const go = browser();
  const { verifier, challenge } = pkce();
  const redirectUri = "http://localhost:4200/";

  const code = await loginAndGetCode(go, {
    client_id: "integration-hub",
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid integration-hub",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
  }, redirectUri);

  const tokens = await exchange(go, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: "integration-hub",
    code_verifier: verifier,
  });

  const { header, payload } = decodeJwt(tokens.access_token);
  assert.equal(header.typ, "at+jwt");
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, baseUrl);
  assert.equal(payload.aud, "https://api.example.test");
  assert.equal(payload.sub, "7");
  assert.equal(payload.client_id, "integration-hub");
  assert.equal(payload.name, "Luka Lozic");
  assert.equal(payload.bitrix_user_type, "employee");
  assert.deepEqual(payload.bitrix_departments, [1]);
  assert.equal(payload.email, "luka@example.test");
  assert.deepEqual(payload.bitrix_workgroups, ["45", "42"], "memberships only: no pending request (Z), no banned user (T)");
  assert.ok(tokens.refresh_token, "refresh token issued");

  const refreshed = await exchange(go, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "integration-hub" });
  assert.equal(decodeJwt(refreshed.access_token).payload.aud, "https://api.example.test");
});

test("Claude (dynamically registered MCP client) still gets an opaque token for /mcp", async () => {
  const go = browser();
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const reg = await go("/reg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const { verifier, challenge } = pkce();

  const code = await loginAndGetCode(go, {
    client_id,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "bitrix24",
    resource: `${baseUrl}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s2",
  }, redirectUri);

  const tokens = await exchange(go, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id,
    code_verifier: verifier,
    resource: `${baseUrl}/mcp`,
  });

  assert.equal(tokens.access_token.split(".").length, 1, "opaque token, not a JWT");
  assert.equal(tokens.scope, "bitrix24");
  assert.ok(tokens.refresh_token);
});

// Claude and Integration Hub share the employee's browser session on this server. Logging out of
// Integration Hub revokes only its own token; Claude's connector must stay connected.
test("revoking the Integration Hub token in a shared browser session keeps Claude connected", async () => {
  const go = browser();
  const claudeRedirect = "https://claude.ai/api/mcp/auth_callback";
  const reg = await go("/reg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [claudeRedirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const { client_id: claudeId } = await reg.json();

  const claudePkce = pkce();
  const claudeCode = await loginAndGetCode(go, {
    client_id: claudeId, response_type: "code", redirect_uri: claudeRedirect, scope: "bitrix24",
    resource: `${baseUrl}/mcp`, code_challenge: claudePkce.challenge, code_challenge_method: "S256", state: "c",
  }, claudeRedirect);
  const claude = await exchange(go, {
    grant_type: "authorization_code", code: claudeCode, redirect_uri: claudeRedirect, client_id: claudeId,
    code_verifier: claudePkce.verifier, resource: `${baseUrl}/mcp`,
  });

  const hubRedirect = "http://localhost:4200/";
  const hubPkce = pkce();
  const hubCode = await loginAndGetCode(go, {
    client_id: "integration-hub", response_type: "code", redirect_uri: hubRedirect, scope: "openid integration-hub",
    code_challenge: hubPkce.challenge, code_challenge_method: "S256", state: "h",
  }, hubRedirect);
  const hub = await exchange(go, {
    grant_type: "authorization_code", code: hubCode, redirect_uri: hubRedirect, client_id: "integration-hub", code_verifier: hubPkce.verifier,
  });

  const revoke = await go("/token/revocation", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: hub.refresh_token, token_type_hint: "refresh_token", client_id: "integration-hub" }),
  });
  assert.equal(revoke.status, 200);

  const hubRefresh = await go("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: hub.refresh_token, client_id: "integration-hub" }),
  });
  assert.equal(hubRefresh.status, 400, "revoked Integration Hub refresh token no longer works");

  const claudeRefresh = await exchange(go, { grant_type: "refresh_token", refresh_token: claude.refresh_token, client_id: claudeId, resource: `${baseUrl}/mcp` });
  assert.equal(claudeRefresh.scope, "bitrix24");
  assert.equal(claudeRefresh.access_token.split(".").length, 1);
});

// Enabling Integration Hub adds its scope to the discovery document; a client that asks for every
// advertised scope together with the MCP resource must still get a plain bitrix24 MCP token.
test("Claude requesting all advertised scopes still gets only a bitrix24 token for /mcp", async () => {
  const go = browser();
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const reg = await go("/reg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const { client_id } = await reg.json();
  const { verifier, challenge } = pkce();

  const code = await loginAndGetCode(go, {
    client_id, response_type: "code", redirect_uri: redirectUri, scope: "bitrix24 integration-hub",
    resource: `${baseUrl}/mcp`, code_challenge: challenge, code_challenge_method: "S256", state: "s3",
  }, redirectUri);
  const tokens = await exchange(go, {
    grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id, code_verifier: verifier, resource: `${baseUrl}/mcp`,
  });

  assert.equal(tokens.scope, "bitrix24");
  assert.equal(tokens.access_token.split(".").length, 1);
});

test("a failing workgroup lookup does not block the Integration Hub login (no extra permissions)", async () => {
  workgroupLookupFails = true;
  try {
    const go = browser();
    const { verifier, challenge } = pkce();
    const redirectUri = "http://localhost:4200/";
    const code = await loginAndGetCode(go, {
      client_id: "integration-hub", response_type: "code", redirect_uri: redirectUri, scope: "openid integration-hub",
      code_challenge: challenge, code_challenge_method: "S256", state: "w",
    }, redirectUri);
    const tokens = await exchange(go, {
      grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: "integration-hub", code_verifier: verifier,
    });
    const { payload } = decodeJwt(tokens.access_token);
    assert.deepEqual(payload.bitrix_workgroups, []);
    assert.equal(payload.bitrix_user_type, "employee");
  } finally {
    workgroupLookupFails = false;
  }
});
