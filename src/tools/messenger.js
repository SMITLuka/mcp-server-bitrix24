import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";

export function registerMessengerTools(server, employeeId) {
  server.tool(
    "bitrix_find_chat",
    "Find Bitrix24 group chats (including workgroup/project chats) by name and return their chat IDs, " +
      "for use with bitrix_send_chat_message. Only chats the current user can see are returned.",
    { query: z.string().describe("Part of the chat name, e.g. 'Vector DEV'") },
    async ({ query }) => {
      const chats = await callBitrix(employeeId, "im.search.chat.list", { FIND: query });
      const trimmed = (chats || []).map((c) => ({
        chatId: c.id,
        // im.search.chat.list names the chat in `name`, not `title`.
        title: c.name ?? c.title,
        type: c.type,
        members: c.user_counter ?? c.userCounter,
      }));
      return { content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_send_chat_message",
    "Send a Bitrix24 chat message as the current user, either privately to one colleague (userId) or into a " +
      "group chat (chatId). This sends a real message to real people - a group chat reaches everyone in it: " +
      "always confirm the recipient and the exact text with the user before calling it. Look up a colleague's ID " +
      "with bitrix_find_employee and a group chat's ID with bitrix_find_chat. Pass exactly one of userId or chatId.",
    {
      userId: z.string().optional().describe("Bitrix user ID of the recipient (private message)"),
      chatId: z.string().optional().describe("Group chat ID from bitrix_find_chat"),
      message: z.string(),
    },
    async ({ userId, chatId, message }) => {
      if (Boolean(userId) === Boolean(chatId)) {
        throw new Error("Pass exactly one of userId (private message) or chatId (group chat).");
      }

      // im.message.add: a private chat uses the recipient's user ID as DIALOG_ID,
      // a group chat uses "chat<ID>".
      const dialogId = userId ?? `chat${chatId}`;
      const messageId = await callBitrix(employeeId, "im.message.add", {
        DIALOG_ID: dialogId,
        MESSAGE: message,
      });
      return { content: [{ type: "text", text: JSON.stringify({ sentTo: dialogId, messageId }, null, 2) }] };
    }
  );
}
