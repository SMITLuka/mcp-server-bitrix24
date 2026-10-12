// describeCrmFields is what makes custom deal fields (UF_CRM_...) readable, so the
// label lookup, empty-field filtering, list resolution and truncation are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCrmFields } from "../src/crmFields.js";

test("uses the UI label of custom fields and the title of standard fields", () => {
  const result = describeCrmFields(
    { TITLE: "Ne radi ispis", UF_CRM_1: "Restart servisa" },
    {
      TITLE: { type: "string", title: "Name" },
      UF_CRM_1: { type: "string", title: "UF_CRM_1", formLabel: "Rješenje", listLabel: "Rješenje (lista)" },
    }
  );
  assert.deepEqual(result, [
    { code: "TITLE", label: "Name", type: "string", value: "Ne radi ispis" },
    { code: "UF_CRM_1", label: "Rješenje", type: "string", value: "Restart servisa" },
  ]);
});

test("falls back to listLabel, then title, then the code", () => {
  const result = describeCrmFields(
    { A: "1", B: "2", C: "3" },
    { A: { listLabel: "List A", title: "A" }, B: { title: "Title B" } }
  );
  assert.deepEqual(
    result.map((f) => f.label),
    ["List A", "Title B", "C"]
  );
});

test("drops empty values but keeps zero and N", () => {
  const result = describeCrmFields({ A: null, B: "", C: [], D: undefined, E: "0", F: 0, G: "N" });
  assert.deepEqual(
    result.map((f) => f.code),
    ["E", "F", "G"]
  );
});

test("resolves enumeration item IDs to their text, single and multiple", () => {
  const definitions = {
    S: { type: "enumeration", items: [{ ID: "10", VALUE: "Hitno" }, { ID: "11", VALUE: "Normalno" }] },
    M: { type: "enumeration", items: [{ ID: "10", VALUE: "Hitno" }] },
  };
  const result = describeCrmFields({ S: "11", M: ["10", "99"] }, definitions);
  assert.equal(result[0].value, "Normalno");
  assert.deepEqual(result[1].value, ["Hitno", "99"]);
});

test("truncates very long text values", () => {
  const [field] = describeCrmFields({ COMMENTS: "x".repeat(5000) });
  assert.ok(field.value.length < 5000);
  assert.match(field.value, /\[truncated - 5000 chars total\]$/);
});
