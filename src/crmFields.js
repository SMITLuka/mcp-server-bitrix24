// Turns a raw CRM record (crm.deal.get) into a list of its filled-in fields with
// the labels people see in the Bitrix UI. Custom fields come back from the API
// only as codes like UF_CRM_1712345678, so without the label from
// crm.deal.fields nobody can tell which one is e.g. "Rješenje".

const MAX_VALUE_CHARS = 4000;

function isEmpty(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

// Custom fields of type "enumeration" (lists) store item IDs, not the text the
// user picked; the definition carries the ID -> text mapping.
function resolveEnumeration(value, definition) {
  const items = definition?.items;
  if (!Array.isArray(items)) return value;
  const byId = new Map(items.map((i) => [String(i.ID), i.VALUE]));
  const resolve = (v) => byId.get(String(v)) ?? v;
  return Array.isArray(value) ? value.map(resolve) : resolve(value);
}

// Long texts (ticket bodies, solutions) are cut so one record cannot blow the
// tool response size limit.
function truncate(value) {
  if (typeof value !== "string" || value.length <= MAX_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_VALUE_CHARS)} [truncated - ${value.length} chars total]`;
}

export function describeCrmFields(record, definitions = {}) {
  return Object.entries(record ?? {})
    .filter(([, value]) => !isEmpty(value))
    .map(([code, value]) => {
      const definition = definitions[code];
      // Standard fields have a proper "title"; custom fields have only the code
      // there and keep the UI name in formLabel/listLabel.
      const label = definition?.formLabel || definition?.listLabel || definition?.title || code;
      return {
        code,
        label,
        type: definition?.type ?? null,
        value: truncate(definition?.type === "enumeration" ? resolveEnumeration(value, definition) : value),
      };
    });
}
