import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";

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
}
