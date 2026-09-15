import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";

export function registerTaskTools(server, employeeId) {
  server.tool(
    "bitrix_list_my_tasks",
    "List the current Bitrix24 user's tasks",
    { status: z.enum(["all", "pending", "completed"]).optional() },
    async ({ status = "all" }) => {
      const filter = status === "pending" ? { REAL_STATUS: [2, 3] } : status === "completed" ? { REAL_STATUS: 5 } : {};
      const result = await callBitrix(employeeId, "tasks.task.list", {
        filter,
        select: ["ID", "TITLE", "STATUS", "DEADLINE"],
      });
      return { content: [{ type: "text", text: JSON.stringify(result.tasks ?? result, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_create_task",
    "Create a new Bitrix24 task assigned to the current user",
    {
      title: z.string(),
      description: z.string().optional(),
      responsibleId: z.string().optional(),
      deadline: z.string().optional().describe("ISO date, e.g. 2026-09-30"),
    },
    async ({ title, description, responsibleId, deadline }) => {
      const result = await callBitrix(employeeId, "tasks.task.add", {
        fields: {
          TITLE: title,
          DESCRIPTION: description,
          RESPONSIBLE_ID: responsibleId,
          DEADLINE: deadline,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
