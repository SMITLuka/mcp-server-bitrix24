import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";

const JWKS_PATH = process.env.JWKS_PATH || "./data/jwks.json";

// Signing keys must survive restarts, otherwise every access/refresh token
// issued by the OIDC provider becomes unverifiable the moment the container
// restarts, forcing every employee to redo the Bitrix login.
export async function loadOrCreateJwks() {
  if (existsSync(JWKS_PATH)) {
    return JSON.parse(readFileSync(JWKS_PATH, "utf8"));
  }

  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = randomUUID();
  jwk.alg = "RS256";
  jwk.use = "sig";

  const jwks = { keys: [jwk] };
  mkdirSync(dirname(JWKS_PATH), { recursive: true });
  writeFileSync(JWKS_PATH, JSON.stringify(jwks, null, 2));
  return jwks;
}
