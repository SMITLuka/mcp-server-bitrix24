import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: required("BASE_URL"),
  bitrixDomain: required("BITRIX_DOMAIN"),
  clientId: required("BITRIX_CLIENT_ID"),
  clientSecret: required("BITRIX_CLIENT_SECRET"),
  dbPath: process.env.DB_PATH || "./data/mcp.sqlite",
};

// Optional second relying party: the Integration Hub web app logs its users in through this
// server's Bitrix24 login. Enabled only when both variables are set; without them the server
// behaves exactly as before (no extra client, no extra resource).
const integrationHubRedirectUris = (process.env.INTEGRATION_HUB_REDIRECT_URIS || "")
  .split(",")
  .map((uri) => uri.trim())
  .filter(Boolean);

export const integrationHub = {
  clientId: "integration-hub",
  apiUrl: process.env.INTEGRATION_HUB_API_URL || null,
  redirectUris: integrationHubRedirectUris,
  enabled: Boolean(process.env.INTEGRATION_HUB_API_URL) && integrationHubRedirectUris.length > 0,
};

export const bitrixUrls = {
  // Authorization happens on the customer's own portal (that's where the user logs in),
  // but token issuance/refresh is centralized on Bitrix's OAuth server even for
  // self-hosted/local applications: https://apidocs.bitrix24.com/settings/oauth/index.html
  authorize: `https://${config.bitrixDomain}/oauth/authorize/`,
  token: `https://oauth.bitrix.info/oauth/token/`,
  rest: (method) => `https://${config.bitrixDomain}/rest/${method}.json`,
};
