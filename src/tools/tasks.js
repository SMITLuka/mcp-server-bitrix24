import { z } from "zod";
import { callBitrix } from "../bitrixClient.js";
import { getEmployeeById } from "../db.js";

export function registerTaskTools(server, employeeId) {
  server.tool(
    "bitrix_list_my_tasks",
    "List the current Bitrix24 user's tasks, most recent first",
    { status: z.enum(["all", "pending", "completed"]).optional().describe("Defaults to 'pending'") },
    async ({ status = "pending" }) => {
      const employee = getEmployeeById(employeeId);

      // tasks.task.list with no RESPONSIBLE_ID filter returns everything the
      // access token's permission level can see (which for anyone with
      // elevated/admin rights in Bitrix can mean *other people's* tasks too)
      // rather than just tasks assigned to this specific employee.
      const filter = { RESPONSIBLE_ID: employee.bitrix_user_id };
      if (status === "pending") filter.REAL_STATUS = [2, 3];
      if (status === "completed") filter.REAL_STATUS = 5;

      const result = await callBitrix(employeeId, "tasks.task.list", {
        filter,
        order: { ID: "desc" }, // otherwise Bitrix defaults to oldest-first
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
      responsibleId: z.string().optional().describe("Defaults to the current user"),
      deadline: z.string().optional().describe("ISO date, e.g. 2026-09-30"),
    },
    async ({ title, description, responsibleId, deadline }) => {
      const employee = getEmployeeById(employeeId);
      const result = await callBitrix(employeeId, "tasks.task.add", {
        fields: {
          TITLE: title,
          DESCRIPTION: description,
          RESPONSIBLE_ID: responsibleId || employee.bitrix_user_id,
          DEADLINE: deadline,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "bitrix_attach_file_to_task",
    "Upload a file and attach it to an existing Bitrix24 task",
    {
      taskId: z.string(),
      fileName: z.string(),
      fileContentBase64: z.string().describe("Base64-encoded file content"),
    },
    async ({ taskId, fileName, fileContentBase64 }) => {
      const employee = getEmployeeById(employeeId);
      const step = async (label, fn) => {
        try {
          return await fn();
        } catch (err) {
          throw new Error(`[${label}] ${err.message}`);
        }
      };

      // Bitrix24 has no "attach file to task" endpoint that takes raw content
      // directly. The two-step dance: upload into the user's own Disk
      // storage, then point the task's UF_TASK_WEBDAV_FILES field at it.
      const storages = await step("disk.storage.getlist", () =>
        callBitrix(employeeId, "disk.storage.getlist", {
          filter: { ENTITY_TYPE: "user", ENTITY_ID: employee.bitrix_user_id },
        })
      );
      const folderId = storages?.[0]?.ROOT_OBJECT_ID;
      if (!folderId) {
        throw new Error(
          `Could not find a personal Bitrix Disk storage for this user. Raw response: ${JSON.stringify(storages)}`
        );
      }

      const uploaded = await step("disk.folder.uploadfile", () =>
        callBitrix(employeeId, "disk.folder.uploadfile", {
          id: folderId,
          fileContent: [fileName, fileContentBase64],
          data: { NAME: fileName },
        })
      );
      const uploadedFileId = uploaded?.ID ?? uploaded?.file?.ID;
      if (!uploadedFileId) {
        throw new Error(`Unexpected upload response from Bitrix24: ${JSON.stringify(uploaded)}`);
      }
      // TEMP DEBUG: surface exactly what we extracted + the raw shape, since
      // tasks.task.update is rejecting the ID with "File could not be found".
      const debugContext = ` [debug: uploadedFileId=${uploadedFileId} raw=${JSON.stringify(uploaded)}]`;

      const taskResult = await step("tasks.task.get", () =>
        callBitrix(employeeId, "tasks.task.get", {
          taskId,
          select: ["UF_TASK_WEBDAV_FILES"],
        })
      );
      const existingFileIds = taskResult?.task?.ufTaskWebdavFiles ?? taskResult?.task?.UF_TASK_WEBDAV_FILES ?? [];

      const updateResult = await step("tasks.task.update" + debugContext, () =>
        callBitrix(employeeId, "tasks.task.update", {
          taskId,
          fields: { UF_TASK_WEBDAV_FILES: [...existingFileIds, uploadedFileId] },
        })
      );

      return {
        content: [{ type: "text", text: JSON.stringify({ uploadedFileId, updateResult }, null, 2) }],
      };
    }
  );
}
