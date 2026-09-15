import Provider from "oidc-provider";
import { config } from "./config.js";
import SqliteAdapter from "./oidcAdapter.js";
import { loadOrCreateJwks } from "./jwks.js";
import { getEmployeeByBitrixUserId } from "./db.js";

export async function createOidcProvider() {
  const jwks = await loadOrCreateJwks();

  const provider = new Provider(config.baseUrl, {
    adapter: SqliteAdapter,
    jwks,
    clients: [], // no pre-registered clients: MCP clients (Claude) self-register via DCR

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
    },

    pkce: { required: () => true },

    scopes: ["bitrix24"],

    // Public clients like Claude's connector don't hold a client_secret, so
    // grant long-lived access without forcing a re-consent screen per employee.
    issueRefreshToken: () => true,

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
