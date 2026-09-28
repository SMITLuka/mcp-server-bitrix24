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
      // sonet_group.get returns ~20 verbose fields per group (permissions,
      // dates, keywords...) and this account belongs to 100+ groups, which
      // blew past the response size limit. Trim to what's actually useful.
      const { items, total } = await callBitrixAllPages(employeeId, "sonet_group.get", {
        order: { NAME: "asc" },
      });
      const trimmed = items.map((g) => ({
        id: g.ID,
        name: g.NAME,
        isProject: g.PROJECT === "Y",
        opened: g.OPENED === "Y",
        members: g.NUMBER_OF_MEMBERS,
      }));

      const text =
        total > trimmed.length
          ? `Showing ${trimmed.length} of ${total} total (capped).\n\n${JSON.stringify(trimmed, null, 2)}`
          : JSON.stringify(trimmed, null, 2);

      return { content: [{ type: "text", text }] };
    }
  );
}
