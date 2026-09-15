import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    bitrix_user_id TEXT,
    bitrix_user_name TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_bitrix_user_id
    ON employees(bitrix_user_id) WHERE bitrix_user_id IS NOT NULL;

  -- Storage for the oidc-provider library (OAuth sessions/grants/tokens issued
  -- to MCP clients like Claude's custom connector). See src/oidcAdapter.js.
  CREATE TABLE IF NOT EXISTS oidc_model (
    model TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    grant_id TEXT,
    user_code TEXT,
    uid TEXT,
    expires_at INTEGER,
    consumed_at INTEGER,
    PRIMARY KEY (model, id)
  );
  CREATE INDEX IF NOT EXISTS idx_oidc_grant_id ON oidc_model(grant_id);
  CREATE INDEX IF NOT EXISTS idx_oidc_user_code ON oidc_model(user_code);
  CREATE INDEX IF NOT EXISTS idx_oidc_uid ON oidc_model(uid);
`);

export function createEmployee(name) {
  const apiKey = randomBytes(24).toString("hex");
  db.prepare("INSERT INTO employees (name, api_key) VALUES (?, ?)").run(name, apiKey);
  return apiKey;
}

export function getEmployeeByApiKey(apiKey) {
  return db.prepare("SELECT * FROM employees WHERE api_key = ?").get(apiKey);
}

export function getEmployeeById(id) {
  return db.prepare("SELECT * FROM employees WHERE id = ?").get(id);
}

export function getEmployeeByBitrixUserId(bitrixUserId) {
  return db.prepare("SELECT * FROM employees WHERE bitrix_user_id = ?").get(bitrixUserId);
}

// Used by the OIDC login flow (Claude Custom Connector), where there is no
// pre-issued api_key — the account is created the first time someone
// completes Bitrix24 login. api_key still gets a random placeholder value so
// it satisfies the NOT NULL UNIQUE constraint shared with the legacy
// manually-provisioned (add-employee.js) accounts; it is never handed out.
export function findOrCreateAccountByBitrixUser(bitrixUserId, bitrixUserName) {
  const existing = getEmployeeByBitrixUserId(bitrixUserId);
  if (existing) return existing.id;

  const placeholderKey = `oidc:${randomBytes(16).toString("hex")}`;
  const result = db
    .prepare("INSERT INTO employees (name, api_key, bitrix_user_id, bitrix_user_name) VALUES (?, ?, ?, ?)")
    .run(bitrixUserName || `Bitrix user ${bitrixUserId}`, placeholderKey, bitrixUserId, bitrixUserName || null);
  return Number(result.lastInsertRowid);
}

export function listEmployees() {
  return db
    .prepare("SELECT id, name, bitrix_user_name, expires_at, created_at FROM employees")
    .all();
}

export function saveTokensById(id, { access_token, refresh_token, expires_in, bitrix_user_id, bitrix_user_name }) {
  const expiresAt = Math.floor(Date.now() / 1000) + Number(expires_in || 0);
  db.prepare(
    `UPDATE employees
     SET access_token = ?, refresh_token = ?, expires_at = ?, bitrix_user_id = COALESCE(?, bitrix_user_id),
         bitrix_user_name = COALESCE(?, bitrix_user_name), updated_at = unixepoch()
     WHERE id = ?`
  ).run(access_token, refresh_token, expiresAt, bitrix_user_id ?? null, bitrix_user_name ?? null, id);
}

export function saveTokens(apiKey, tokens) {
  const employee = getEmployeeByApiKey(apiKey);
  if (!employee) throw new Error(`saveTokens: unknown api_key`);
  saveTokensById(employee.id, tokens);
}

export default db;
