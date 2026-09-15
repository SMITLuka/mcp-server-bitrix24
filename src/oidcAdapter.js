import db from "./db.js";

const upsertStmt = db.prepare(`
  INSERT INTO oidc_model (model, id, payload, grant_id, user_code, uid, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(model, id) DO UPDATE SET
    payload = excluded.payload,
    grant_id = excluded.grant_id,
    user_code = excluded.user_code,
    uid = excluded.uid,
    expires_at = excluded.expires_at
`);
const findStmt = db.prepare("SELECT * FROM oidc_model WHERE model = ? AND id = ?");
const findByUserCodeStmt = db.prepare("SELECT * FROM oidc_model WHERE model = ? AND user_code = ?");
const findByUidStmt = db.prepare("SELECT * FROM oidc_model WHERE model = ? AND uid = ?");
const consumeStmt = db.prepare("UPDATE oidc_model SET consumed_at = ? WHERE model = ? AND id = ?");
const destroyStmt = db.prepare("DELETE FROM oidc_model WHERE model = ? AND id = ?");
const revokeByGrantIdStmt = db.prepare("DELETE FROM oidc_model WHERE grant_id = ?");

function rowToPayload(row) {
  if (!row) return undefined;
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) return undefined;

  const payload = JSON.parse(row.payload);
  if (row.consumed_at) payload.consumed = row.consumed_at;
  return payload;
}

// Adapter interface expected by oidc-provider:
// https://github.com/panva/node-oidc-provider/blob/main/docs/README.md#adapter
export default class SqliteAdapter {
  constructor(model) {
    this.model = model;
  }

  async upsert(id, payload, expiresIn) {
    const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;
    upsertStmt.run(
      this.model,
      id,
      JSON.stringify(payload),
      payload.grantId ?? null,
      payload.userCode ?? null,
      payload.uid ?? null,
      expiresAt
    );
  }

  async find(id) {
    return rowToPayload(findStmt.get(this.model, id));
  }

  async findByUserCode(userCode) {
    return rowToPayload(findByUserCodeStmt.get(this.model, userCode));
  }

  async findByUid(uid) {
    return rowToPayload(findByUidStmt.get(this.model, uid));
  }

  async consume(id) {
    consumeStmt.run(Math.floor(Date.now() / 1000), this.model, id);
  }

  async destroy(id) {
    destroyStmt.run(this.model, id);
  }

  async revokeByGrantId(grantId) {
    revokeByGrantIdStmt.run(grantId);
  }
}
