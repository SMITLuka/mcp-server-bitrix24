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
    "List the Bitrix24 workgroups/projects the current user is actually a MEMBER of, with their role " +
      "(A = owner, E = moderator, K = member). For every group the user is merely allowed to see, use " +
      "bitrix_list_visible_workgroups.",
    {},
    async () => {
      const groups = await callBitrix(employeeId, "sonet_group.user.groups", {});
      const roles = { A: "owner", E: "moderator", K: "member" };
      const trimmed = (groups || [])
        .map((g) => ({
          id: g.GROUP_ID,
          name: g.GROUP_NAME,
          role: roles[g.ROLE] ?? g.ROLE,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_list_visible_workgroups",
    "List every Bitrix24 workgroup/project the current user is allowed to SEE (often 100+, not necessarily a " +
      "member). Use bitrix_list_my_workgroups for real membership.",
    {},
    async () => {
      // sonet_group.get returns ~20 verbose fields per group (permissions,
      // dates, keywords...) and this account sees 100+ groups, which
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
          ? `Showing ${trimmed.length} of ${total} total (capped).

${JSON.stringify(trimmed, null, 2)}`
          : JSON.stringify(trimmed, null, 2);

      return { content: [{ type: "text", text }] };
    }
  );
}
