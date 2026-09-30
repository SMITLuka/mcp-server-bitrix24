import Provider, { errors } from "oidc-provider";
import { config, integrationHub } from "./config.js";
import SqliteAdapter from "./oidcAdapter.js";
import { loadOrCreateJwks } from "./jwks.js";
import { getEmployeeByBitrixUserId } from "./db.js";
import { callBitrix, callBitrixAllPages } from "./bitrixClient.js";

const MCP_RESOURCE = `${config.baseUrl}/mcp`;
const INTEGRATION_HUB_SCOPE = "integration-hub";
const BITRIX_LOOKUP_TIMEOUT_MS = 5000;

// Integration Hub is a browser app (public client, PKCE, no secret) that only uses this server
// as its login: it gets a JWT access token for its own API, never a token for /mcp.
export function integrationHubClients() {
  if (!integrationHub.enabled) return [];
  return [
    {
      client_id: integrationHub.clientId,
      client_name: "Integration Hub",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: integrationHub.redirectUris,
      scope: `openid ${INTEGRATION_HUB_SCOPE}`,
    },
  ];
}

function isIntegrationHubClient(client) {
  return integrationHub.enabled && client?.clientId === integrationHub.clientId;
}

// Resource selection, exported so the behaviour for Claude (MCP resource) and Integration Hub can be tested.
export function defaultResource(ctx, client) {
  return isIntegrationHubClient(client) ? integrationHub.apiUrl : MCP_RESOURCE;
}

export function resourceServerInfo(ctx, resourceIndicator, client) {
  if (resourceIndicator === MCP_RESOURCE && !isIntegrationHubClient(client)) {
    return { scope: "bitrix24", accessTokenFormat: "opaque" };
  }
  if (isIntegrationHubClient(client) && resourceIndicator === integrationHub.apiUrl) {
    return {
      scope: INTEGRATION_HUB_SCOPE,
      audience: integrationHub.apiUrl,
      accessTokenFormat: "jwt",
      jwt: { sign: { alg: "RS256" } },
    };
  }
  // oidc-provider v9 exports its errors by name; Provider.errors is undefined (it threw a TypeError before).
  throw new errors.InvalidTarget();
}

// These lookups run inside the /token request: a hanging Bitrix must not hang the login. Only
// these calls are time-limited; the shared callBitrix used by the MCP tools keeps its behaviour.
function withTimeout(promise, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Bitrix24 ${what} timed out`)), BITRIX_LOOKUP_TIMEOUT_MS).unref()
    ),
  ]);
}

// Workgroup memberships decide Integration Hub's extra permissions. Only real memberships count
// (A owner, E moderator, K member) - an allowlist, so pending requests/invitations (Z), banned
// users (T) or any future role never grant anything. A failed lookup must not block the login:
// the user then simply gets the base permissions, which only ever grants less.
const MEMBER_ROLES = new Set(["A", "E", "K"]);

async function memberWorkgroupIds(employeeId) {
  try {
    const { items } = await withTimeout(callBitrixAllPages(employeeId, "sonet_group.user.groups", {}), "sonet_group.user.groups");
    return items.filter((group) => MEMBER_ROLES.has(group.ROLE)).map((group) => String(group.GROUP_ID));
  } catch (err) {
    console.error(`[integration-hub] workgroup lookup failed for employee ${employeeId}: ${err.message}`);
    return [];
  }
}

// Integration Hub restricts access to intranet employees and grants extra permissions by
// workgroup; both are looked up live on every token issue/refresh, so changes in Bitrix take
// effect within one access-token lifetime.
async function integrationHubClaims(accountId) {
  const employee = getEmployeeByBitrixUserId(accountId);
  if (!employee) throw new Error(`Unknown Bitrix24 account ${accountId}`);

  // Sequential on purpose: both calls may refresh the employee's Bitrix token (shared with the MCP
  // tools), and Bitrix rotates refresh tokens - two parallel refreshes would make one of them fail.
  // callBitrix re-reads the employee, so the second call reuses the token the first one refreshed.
  const user = await withTimeout(callBitrix(employee.id, "user.current"), "user.current");
  const workgroups = await memberWorkgroupIds(employee.id);
  return {
    name: `${user.NAME || ""} ${user.LAST_NAME || ""}`.trim() || undefined,
    email: user.EMAIL || undefined,
    bitrix_user_type: user.USER_TYPE ?? null,
    bitrix_departments: Array.isArray(user.UF_DEPARTMENT) ? user.UF_DEPARTMENT : [],
    bitrix_workgroups: workgroups,
  };
}

export async function createOidcProvider() {
  const jwks = await loadOrCreateJwks();

  const provider = new Provider(config.baseUrl, {
    adapter: SqliteAdapter,
    jwks,
    // MCP clients (Claude) self-register via DCR; Integration Hub (optional) is the only static client.
    clients: integrationHubClients(),

    // Anyone can dynamically register a client (this is how Claude's Custom
    // Connector adds itself the first time an admin configures the URL).
    // There is no separate "app store" review step for an internal tool, so
    // this is an acceptable trade-off; the actual data access is still gated
    // per-employee by the Bitrix24 login every user has to complete below.
    features: {
      registration: { enabled: true, initialAccessToken: false },
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },

      // MCP clients (per the MCP Authorization spec) send a `resource` param
      // (RFC 8707) to bind the token to this specific MCP server. The MCP
      // resource keeps its opaque tokens; the optional Integration Hub API
      // resource gets JWTs so its backend can verify them offline via /jwks.
      resourceIndicators: {
        enabled: true,
        // Integration Hub never asks for a resource explicitly, so its default must be its own API
        // (the token endpoint also relies on this, because its login includes the openid scope).
        defaultResource,
        getResourceServerInfo: resourceServerInfo,
        // With the openid scope, a token request without `resource` would otherwise get a UserInfo
        // token instead of the API JWT. Integration Hub never sends `resource`, so its token and
        // refresh requests reuse the resource granted at login. Everyone else keeps the default (false).
        useGrantedResource: (ctx) => isIntegrationHubClient(ctx.oidc.client),
      },
    },

    pkce: { required: () => true },

    scopes: integrationHub.enabled ? ["bitrix24", INTEGRATION_HUB_SCOPE] : ["bitrix24"],

    // Public clients like Claude's connector don't hold a client_secret, so
    // grant long-lived access without forcing a re-consent screen per employee.
    issueRefreshToken: () => true,

    extraTokenClaims: async (ctx, token) => {
      if (token.kind !== "AccessToken" || !isIntegrationHubClient(ctx.oidc.client)) return undefined;
      return integrationHubClaims(token.accountId);
    },

    interactions: {
      url(ctx, interaction) {
        return `/interaction/${interaction.uid}`;
      },
    },

    findAccount(ctx, accountId) {
      const employee = getEmployeeByBitrixUserId(accountId);
      if (!employee) return undefined;

      return {
        accountId,
        async claims() {
          return { sub: accountId, name: employee.bitrix_user_name || undefined };
        },
      };
    },

    ttl: {
      AccessToken: 60 * 60, // 1 hour; bitrixClient.js refreshes the underlying Bitrix token separately
      RefreshToken: 60 * 60 * 24 * 180,
      AuthorizationCode: 60,
      Interaction: 60 * 15,
      Grant: 60 * 60 * 24 * 365,
    },
  });

  provider.proxy = true; // we sit behind Caddy/Coolify's reverse proxy (TLS terminated upstream)

  return provider;
}
