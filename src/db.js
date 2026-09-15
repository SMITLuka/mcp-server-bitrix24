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

export function listEmployees() {
  return db
    .prepare("SELECT id, name, bitrix_user_name, expires_at, created_at FROM employees")
    .all();
}

export function saveTokens(apiKey, { access_token, refresh_token, expires_in, bitrix_user_id, bitrix_user_name }) {
  const expiresAt = Math.floor(Date.now() / 1000) + Number(expires_in || 0);
  db.prepare(
    `UPDATE employees
     SET access_token = ?, refresh_token = ?, expires_at = ?, bitrix_user_id = COALESCE(?, bitrix_user_id),
         bitrix_user_name = COALESCE(?, bitrix_user_name), updated_at = unixepoch()
     WHERE api_key = ?`
  ).run(access_token, refresh_token, expiresAt, bitrix_user_id ?? null, bitrix_user_name ?? null, apiKey);
}

export default db;
