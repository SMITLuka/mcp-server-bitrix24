import { z } from "zod";
import { callBitrix, callBitrixAllPages } from "../bitrixClient.js";

export function registerWorkgroupTools(server, employeeId) {
  server.tool(
    "bitrix_create_workgroup",
    "Create a new Bitrix24 workgroup/project",
    {
      name: z.string(),
      description: z.string().optional(),
      isProject: z.boolean().optional().describe("Mark as a Project-type group instead of a plain workgroup"),
      opened: z.boolean().optional().describe("Anyone can join without an invite. Defaults to false (invite-only)."),
    },
    async ({ name, description, isProject, opened }) => {
      const result = await callBitrix(employeeId, "sonet_group.create", {
        NAME: name,
        DESCRIPTION: description,
        PROJECT: isProject ? "Y" : "N",
        OPENED: opened ? "Y" : "N",
        VISIBLE: "Y",
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_list_my_workgroups",
    "List Bitrix24 workgroups/projects the current user belongs to",
    {},
    async () => {
      const { items } = await callBitrixAllPages(employeeId, "sonet_group.get", { order: { NAME: "asc" } });
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );
}
