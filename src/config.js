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

export const bitrixUrls = {
  authorize: `https://${config.bitrixDomain}/oauth/authorize/`,
  token: `https://${config.bitrixDomain}/oauth/token/`,
  rest: (method) => `https://${config.bitrixDomain}/rest/${method}.json`,
};
