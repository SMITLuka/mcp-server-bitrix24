import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";
import { describeCrmFields } from "../crmFields.js";

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
}
