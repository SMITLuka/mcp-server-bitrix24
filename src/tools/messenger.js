import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";

export function registerMessengerTools(server, employeeId) {
  server.tool(
    "bitrix_send_chat_message",
    "Send a private Bitrix24 chat message to a colleague, posted as the current user. " +
      "This sends a real message to a real person: always confirm the recipient and the exact text " +
      "with the user before calling it, and look up the recipient's ID with bitrix_find_employee first.",
    {
      userId: z.string().describe("Bitrix user ID of the recipient (from bitrix_find_employee)"),
      message: z.string(),
    },
    async ({ userId, message }) => {
      // For a private chat, im.message.add takes the recipient's user ID as DIALOG_ID.
      const messageId = await callBitrix(employeeId, "im.message.add", {
        DIALOG_ID: userId,
        MESSAGE: message,
      });
      return { content: [{ type: "text", text: JSON.stringify({ sentTo: userId, messageId }, null, 2) }] };
    }
  );
}
