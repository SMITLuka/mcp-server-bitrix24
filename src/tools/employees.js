import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";

export function registerEmployeeTools(server, employeeId) {
  server.tool(
    "bitrix_find_employee",
    "Find Bitrix24 employees by name or email and return their Bitrix user ID, position and contact details",
    { query: z.string().describe("Name, surname or email, e.g. 'Adriano Matak'") },
    async ({ query }) => {
      const users = await callBitrix(employeeId, "user.search", { FILTER: { FIND: query } });
      const trimmed = (users || []).map((u) => ({
        id: u.ID,
        name: `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim(),
        email: u.EMAIL,
        position: u.WORK_POSITION,
        departments: u.UF_DEPARTMENT,
        active: u.ACTIVE,
      }));
      return { content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
    }
  );
}
