import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";
import { describeCrmFields } from "../crmFields.js";
import { config } from "../config.js";
import { buildBatchCommands, collectCandidates, parseQuery, rankTickets } from "../ticketSearch.js";

export function registerCrmTools(server, employeeId) {
  server.tool(
    "bitrix_find_leads",
    "Search Bitrix24 CRM leads by title or name",
    { query: z.string() },
    async ({ query }) => {
      const result = await callBitrix(employeeId, "crm.lead.list", {
        filter: { "%TITLE": query },
        select: ["ID", "TITLE", "STATUS_ID", "NAME", "LAST_NAME"],
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_get_lead",
    "Get a single Bitrix24 CRM lead by ID",
    { leadId: z.string() },
    async ({ leadId }) => {
      const result = await callBitrix(employeeId, "crm.lead.get", { id: leadId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_get_deal",
    "Get a single Bitrix24 CRM deal by ID. Support tickets are deals. Returns every filled-in field with its " +
      "code (e.g. UF_CRM_...), the label shown in the Bitrix UI, and its type, plus the pipeline (CATEGORY_ID) " +
      "and stage (STAGE_ID). Long texts are truncated.",
    { dealId: z.string() },
    async ({ dealId }) => {
      // crm.deal.get returns custom fields only as UF_CRM_<number> codes;
      // crm.deal.fields supplies the labels people know them by.
      const [deal, definitions] = await Promise.all([
        callBitrix(employeeId, "crm.deal.get", { id: dealId }),
        callBitrix(employeeId, "crm.deal.fields"),
      ]);
      const fields = describeCrmFields(deal, definitions);
      return { content: [{ type: "text", text: JSON.stringify({ id: dealId, fields }, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_search_tickets",
    "Search support tickets (CRM deals) by keywords in the title, the customer's e-mail text (Source information), " +
      "the comment and the solution (Rješenje). Every word must appear somewhere; case and diacritics are ignored " +
      "when matching and ranking. Hits in the title or solution rank first. Returns ID, title, stage, " +
      "assignee ID, creation date, link and a snippet around the hit; only tickets the user may see in Bitrix. " +
      "Use bitrix_get_deal for a ticket's full details and bitrix_find_employee to name an assignee.",
    {
      query: z.string().describe("Keywords, e.g. 'rabat 014 Metalac'"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results, default 20"),
    },
    async ({ query, limit = 20 }) => {
      const { words, dropped } = parseQuery(query);
      if (words.length === 0) {
        throw new Error("Give at least one keyword of 2 or more characters.");
      }

      // halt: 0 lets the other sub-queries finish if Bitrix rejects one.
      const { cmd, queries } = buildBatchCommands(words);
      const batch = await callBitrix(employeeId, "batch", { halt: 0, cmd });
      const { deals, truncated, errors } = collectCandidates(batch, queries);
      const ranked = rankTickets(deals, words);

      const results = ranked.slice(0, limit).map((ticket) => ({
        ...ticket,
        url: `https://${config.bitrixDomain}/crm/deal/details/${ticket.id}/`,
      }));
      const notes = [];
      if (dropped > 0) notes.push(`Only the first ${words.length} keywords were used (${dropped} ignored).`);
      // Each sub-query returns Bitrix's first page only (the newest 50 deals),
      // so older tickets can be missed for the word/field pairs listed here.
      if (truncated.length) {
        notes.push("Some keywords matched more than 50 tickets in a field; only the newest were checked (see truncated). Add keywords to reach older tickets.");
      }

      const payload = { candidatesMatched: ranked.length, shown: results.length, results };
      if (notes.length) payload.notes = notes;
      if (truncated.length) payload.truncated = truncated;
      if (errors.length) payload.errors = errors;
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );
}
