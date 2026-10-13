// Pins the matching rules from task #13485's acceptance criteria: case and
// diacritics ignored, every word required, title/solution hits ranked above
// text-only hits, snippets cut from the original text.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBatchCommands,
  cleanText,
  collectCandidates,
  isComplete,
  normalize,
  parseQuery,
  rankTickets,
  toQueryString,
} from "../src/ticketSearch.js";

const SOLUTION = "UF_CRM_1601893231";

test("normalize ignores case and Croatian/Slovenian diacritics, keeping length", () => {
  assert.equal(normalize("ČćŠšŽžĐđ Rješenje CIJENA"), "ccsszzdd rjesenje cijena");
  const text = "Đurđa čeka 😀 rješenje";
  assert.equal(normalize(text).length, text.length);
});

test("parseQuery splits, dedupes across spellings and drops 1-letter words", () => {
  const { words, dropped } = parseQuery("Rješenje, rjesenje a 014!");
  assert.deepEqual(words, [
    { raw: "rješenje", normalized: "rjesenje" },
    { raw: "014", normalized: "014" },
  ]);
  assert.equal(dropped, 0);
});

test("parseQuery keeps at most 6 words and reports the rest", () => {
  const { words, dropped } = parseQuery("aa bb cc dd ee ff gg hh");
  assert.equal(words.length, 6);
  assert.equal(dropped, 2);
});

test("cleanText removes BBCode and HTML and collapses whitespace", () => {
  assert.equal(cleanText("[b]Pozdrav[/b],\r\n\r\n<p>krivi  rabat</p> [URL=/x]link[/URL]"), "Pozdrav , krivi rabat link");
});

test("cleanText decodes the HTML entities Bitrix stores in comments", () => {
  assert.equal(cleanText("Upit - &quot;štampanje&quot; &amp;&nbsp;A&lt;B&gt;"), 'Upit - "štampanje" & A<B>');
  assert.equal(cleanText("it&#039;s it&#39;s"), "it's it's");
  // Decoded once only: an escaped entity stays an entity.
  assert.equal(cleanText("&amp;quot;"), "&quot;");
});

test("toQueryString encodes nested params the way PHP reads them", () => {
  const qs = toQueryString({ filter: { "%TITLE": "š x", CATEGORY_ID: 0 }, select: ["ID", "TITLE"] });
  assert.equal(qs, "filter%5B%25TITLE%5D=%C5%A1%20x&filter%5BCATEGORY_ID%5D=0&select%5B0%5D=ID&select%5B1%5D=TITLE");
});

test("buildBatchCommands sends a word with đ in both spellings for each field and stays under 50 commands", () => {
  const { cmd, queries } = buildBatchCommands(parseQuery("određenom 014").words);
  // određenom: 2 spellings x 4 fields, 014: 1 spelling x 4 fields
  assert.equal(Object.keys(cmd).length, 12);
  assert.ok(Object.values(cmd).every((c) => c.startsWith("crm.deal.list?")));
  assert.deepEqual(queries.w0s1_SOURCE_DESCRIPTION, { word: "odredenom", field: "SOURCE_DESCRIPTION" });

  const max = buildBatchCommands(parseQuery("đa đb đc đd đe đf").words).cmd;
  assert.equal(Object.keys(max).length, 48);
});

test("buildBatchCommands sends other words once per field, as typed, since Bitrix ignores č/ć/š/ž itself", () => {
  const { cmd, queries } = buildBatchCommands(parseQuery("Rješenje").words);
  assert.equal(Object.keys(cmd).length, 4);
  assert.deepEqual(queries.w0s0_TITLE, { word: "rješenje", field: "TITLE" });
});

test("rankTickets requires every word, in any field", () => {
  const deals = [
    { ID: "1", TITLE: "Metalac rabat", SOURCE_DESCRIPTION: "" },
    { ID: "2", TITLE: "Metalac", SOURCE_DESCRIPTION: "krivi RABAT na dokumentu" },
    { ID: "3", TITLE: "Nešto drugo", SOURCE_DESCRIPTION: "rabat" },
  ];
  const ids = rankTickets(deals, parseQuery("metalac rabat").words).map((t) => t.id);
  assert.deepEqual(ids.sort(), ["1", "2"]);
});

test("rankTickets ranks title and solution hits above text-only hits, then newest first", () => {
  const deals = [
    { ID: "10", TITLE: "Upit", SOURCE_DESCRIPTION: "problem s rabatom" },
    { ID: "11", TITLE: "Upit", [SOLUTION]: "Rabatom se ispravlja" },
    { ID: "12", TITLE: "Rabatom krivo", SOURCE_DESCRIPTION: "" },
    { ID: "13", TITLE: "Upit", COMMENTS: "rabatom" },
  ];
  const ids = rankTickets(deals, parseQuery("rabatom").words).map((t) => t.id);
  assert.deepEqual(ids, ["12", "11", "13", "10"]);
});

test("rankTickets matches without diacritics and cuts the snippet from the original text", () => {
  const deals = [{ ID: "5", TITLE: "Upit", [SOLUTION]: "Poštovana, ovo je Rješenje problema." }];
  const [ticket] = rankTickets(deals, parseQuery("rjesenje").words);
  assert.equal(ticket.snippet.field, SOLUTION);
  assert.equal(ticket.snippet.text, "Poštovana, ovo je Rješenje problema.");
  assert.deepEqual(ticket.matchedFields, [SOLUTION]);
});

test("rankTickets shortens long snippets around the hit", () => {
  const long = `${"a ".repeat(200)}KLJUČ${" b".repeat(200)}`;
  const [ticket] = rankTickets([{ ID: "6", SOURCE_DESCRIPTION: long }], parseQuery("kljuc").words);
  assert.ok(ticket.snippet.text.startsWith("..."));
  assert.ok(ticket.snippet.text.endsWith("..."));
  assert.ok(ticket.snippet.text.includes("KLJUČ"));
  assert.ok(ticket.snippet.text.length < 200);
});

test("rankTickets takes the snippet from a non-title field when one matched", () => {
  const deals = [{ ID: "7", TITLE: "Krivi rabat", SOURCE_DESCRIPTION: "Kupac javlja krivi rabat na 014" }];
  const [ticket] = rankTickets(deals, parseQuery("rabat").words);
  assert.equal(ticket.snippet.field, "SOURCE_DESCRIPTION");
});

test("rankTickets falls back to the title snippet when only the title matched", () => {
  const [ticket] = rankTickets([{ ID: "8", TITLE: "Krivi rabat" }], parseQuery("rabat").words);
  assert.deepEqual(ticket.snippet, { field: "TITLE", text: "Krivi rabat" });
});

test("rankTickets snippet handles a hit at the very start and end of a long text", () => {
  const long = `rabat${" x".repeat(200)} kraj`;
  const [start] = rankTickets([{ ID: "9", SOURCE_DESCRIPTION: long }], parseQuery("rabat").words);
  assert.ok(start.snippet.text.startsWith("rabat"));
  const [end] = rankTickets([{ ID: "9", SOURCE_DESCRIPTION: long }], parseQuery("kraj").words);
  assert.ok(end.snippet.text.endsWith("kraj"));
});

test("collectCandidates merges duplicates, reports truncation and dedupes rejected fields", () => {
  const queries = {
    a: { word: "rabat", field: "TITLE" },
    b: { word: "rabat", field: "COMMENTS" },
    c: { word: "014", field: "TITLE" },
    d: { word: "rabat", field: "UF_CRM_1601893231" },
    e: { word: "014", field: "UF_CRM_1601893231" },
  };
  const { deals, truncated, errors } = collectCandidates(
    {
      result: { a: [{ ID: "1" }, { ID: "2" }], b: [{ ID: "2" }], c: [] },
      result_total: { a: 120, b: 1, c: 0 },
      result_error: {
        d: { error: "ERROR", error_description: "Unknown field" },
        e: { error: "ERROR", error_description: "Unknown field" },
      },
    },
    queries
  );
  assert.deepEqual(deals.map((d) => d.ID), ["1", "2"]);
  assert.deepEqual(truncated, [{ word: "rabat", field: "TITLE", matches: 120, fetched: 2 }]);
  assert.deepEqual(errors, [{ field: "UF_CRM_1601893231", error: "Unknown field", words: ["rabat", "014"] }]);
});

test("isComplete is true when at least one word had no truncated sub-query in any spelling", () => {
  const words = parseQuery("metalac rabat").words;
  assert.equal(isComplete(words, [{ word: "rabat", field: "TITLE" }]), true);
  assert.equal(isComplete(words, [{ word: "rabat", field: "TITLE" }, { word: "metalac", field: "COMMENTS" }]), false);
  // A word with đ is sent in two spellings; either one truncated makes it partial.
  const withDj = parseQuery("đurđevac").words;
  assert.equal(isComplete(withDj, [{ word: "đurđevac", field: "TITLE" }]), false);
  assert.equal(isComplete(withDj, [{ word: "durdevac", field: "TITLE" }]), false);
  assert.equal(isComplete(withDj, []), true);
});

test("collectCandidates copes with PHP's empty-array shape for empty maps", () => {
  const { deals, truncated, errors } = collectCandidates({ result: [], result_total: [], result_error: [] }, {});
  assert.deepEqual([deals, truncated, errors], [[], [], []]);
});
