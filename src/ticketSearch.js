// Ticket search: support tickets are CRM deals. Bitrix does the coarse work
// (one "%contains" sub-query per word and field, all in a single batch call,
// run under the user's own token so CRM permissions apply), and the matching
// that Bitrix cannot do - every word present, case/diacritics ignored,
// ranking by field - happens here on the candidates it returns.

// Field -> weight. A hit in the title or in the solution is worth more than a
// hit only in the e-mail text, so those tickets rank first.
export const TICKET_FIELDS = {
  TITLE: 3,
  UF_CRM_1601893231: 3, // "Rješenje"
  SOURCE_DESCRIPTION: 1, // "Source information" - the customer's e-mail text
  COMMENTS: 1,
};

export const TICKET_PIPELINE_ID = 0;

const MAX_WORDS = 6;
const SNIPPET_RADIUS = 80;

// Maps one character to its lowercase, diacritic-free form. Returns exactly
// one UTF-16 unit for each one it gets, so positions in the normalized text
// are positions in the original - that is what lets snippets be cut from the
// original text. "đ" has no decomposed form, so it is mapped explicitly.
function normalizeChar(c) {
  if (c === "đ" || c === "Đ") return "d";
  const mapped = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return mapped.length === c.length ? mapped : c;
}

export function normalize(text) {
  return Array.from(String(text ?? ""), normalizeChar).join("");
}

// Strips BBCode/HTML tags and collapses whitespace, so snippets read as text.
export function cleanText(text) {
  return String(text ?? "")
    .replace(/\[\/?[a-z*][^\]]*\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Splits the query into distinct normalized words of at least 2 characters,
// keeping the first MAX_WORDS so one batch call stays under Bitrix's
// 50-command limit (6 words x 2 spellings x 4 fields = 48).
export function parseQuery(query) {
  const words = [];
  for (const raw of String(query ?? "").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    const word = normalize(raw);
    if (!words.some((w) => w.normalized === word)) words.push({ raw: raw.toLowerCase(), normalized: word });
  }
  return { words: words.slice(0, MAX_WORDS), dropped: Math.max(0, words.length - MAX_WORDS) };
}

// Serializes params the way PHP expects them in a query string
// (filter[%TITLE]=x&select[0]=ID), which is how batch sub-commands are passed.
export function toQueryString(value, prefix = "") {
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([key, inner]) => toQueryString(inner, prefix ? `${prefix}[${key}]` : key))
      .join("&");
  }
  return `${encodeURIComponent(prefix)}=${encodeURIComponent(value)}`;
}

// One crm.deal.list per word, spelling and field. The word is sent both as
// typed and without diacritics, because e-mails are often written without
// them. The reverse (typed without, stored with) relies on Bitrix's own LIKE
// ignoring diacritics, which depends on its database collation.
// `queries` maps each command key back to its word and field, for reporting.
export function buildBatchCommands(words) {
  const select = ["ID", "TITLE", "STAGE_ID", "ASSIGNED_BY_ID", "DATE_CREATE", "CLOSED", ...Object.keys(TICKET_FIELDS)];
  const cmd = {};
  const queries = {};
  words.forEach((word, w) => {
    const spellings = [...new Set([word.raw, word.normalized])];
    spellings.forEach((spelling, s) => {
      for (const field of Object.keys(TICKET_FIELDS)) {
        const params = {
          filter: { [`%${field}`]: spelling, CATEGORY_ID: TICKET_PIPELINE_ID },
          select,
          order: { ID: "DESC" },
        };
        const key = `w${w}s${s}_${field}`;
        cmd[key] = `crm.deal.list?${toQueryString(params)}`;
        queries[key] = { word: spelling, field };
      }
    });
  });
  return { cmd, queries };
}

function snippetFor(text, normalizedText, words) {
  let at = -1;
  let length = 0;
  for (const word of words) {
    const index = normalizedText.indexOf(word.normalized);
    if (index !== -1 && (at === -1 || index < at)) {
      at = index;
      length = word.normalized.length;
    }
  }
  if (at === -1) return null;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

// Keeps only deals that contain every word in at least one field, scores
// each word by the best-weighted field it appears in, and orders by score,
// then newest first.
export function rankTickets(deals, words) {
  const ranked = [];
  for (const deal of deals) {
    const fields = Object.keys(TICKET_FIELDS).map((code) => {
      const text = cleanText(deal[code]);
      return { code, weight: TICKET_FIELDS[code], text, normalized: normalize(text) };
    });

    let score = 0;
    let allFound = true;
    for (const word of words) {
      const best = Math.max(0, ...fields.filter((f) => f.normalized.includes(word.normalized)).map((f) => f.weight));
      if (best === 0) {
        allFound = false;
        break;
      }
      score += best;
    }
    if (!allFound) continue;

    const matched = fields.filter((f) => words.some((w) => f.normalized.includes(w.normalized)));
    // The title is already in the result, so the snippet comes from the best
    // other field that matched (solution first) and only falls back to it.
    const bestField = matched.find((f) => f.code !== "TITLE") ?? matched[0];
    ranked.push({
      id: String(deal.ID),
      title: deal.TITLE,
      stage: deal.STAGE_ID,
      closed: deal.CLOSED === "Y",
      assignedById: deal.ASSIGNED_BY_ID,
      created: deal.DATE_CREATE,
      score,
      matchedFields: matched.map((f) => f.code),
      snippet: { field: bestField.code, text: snippetFor(bestField.text, bestField.normalized, words) },
    });
  }
  return ranked.sort((a, b) => b.score - a.score || Number(b.id) - Number(a.id));
}

// Merges the batch sub-results into one list of distinct deals, lists the
// word/field pairs that had more matches than the one page Bitrix returned,
// and collects rejected sub-queries (e.g. a field Bitrix cannot filter with
// "%"), one entry per field and error since it repeats for every word.
export function collectCandidates(batchResult, queries) {
  const byId = new Map();
  const truncated = [];
  for (const [key, rows] of Object.entries(batchResult?.result ?? {})) {
    const list = Array.isArray(rows) ? rows : [];
    for (const deal of list) byId.set(String(deal.ID), deal);
    const total = Number(batchResult?.result_total?.[key] ?? 0);
    if (total > list.length) truncated.push({ ...queries[key], matches: total, fetched: list.length });
  }

  const errors = new Map();
  for (const [key, error] of Object.entries(batchResult?.result_error ?? {})) {
    const message = error?.error_description || error?.error || JSON.stringify(error);
    const { word, field } = queries[key] ?? { word: key, field: "?" };
    const id = `${field}|${message}`;
    if (!errors.has(id)) errors.set(id, { field, error: message, words: [] });
    errors.get(id).words.push(word);
  }
  return { deals: [...byId.values()], truncated, errors: [...errors.values()] };
}
