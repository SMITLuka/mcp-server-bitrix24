import { z } from "zod";
import axios from "axios";
import { callBitrix, callBitrixAllPages } from "../bitrixClient.js";
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

      // tasks.task.list pages at 50 results per call - without looping
      // through `next`, "all"/"completed" silently looked capped at 50
      // even when the real count was higher.
      const { items, total } = await callBitrixAllPages(
        employeeId,
        "tasks.task.list",
        { filter, order: { ID: "desc" }, select: ["ID", "TITLE", "STATUS", "DEADLINE"] },
        { resultKey: "tasks", maxItems: 300 }
      );

      const text =
        total > items.length
          ? `Showing ${items.length} of ${total} total tasks (capped).\n\n${JSON.stringify(items, null, 2)}`
          : JSON.stringify(items, null, 2);

      return { content: [{ type: "text", text }] };
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
      // directly. Two steps: upload into the user's own Disk storage, then
      // link that Disk file to the task via the dedicated attach method.
      // (UF_TASK_WEBDAV_FILES, the legacy approach, rejected both the Disk
      // object ID and FILE_ID with "File could not be found" when tested
      // live - it's evidently not compatible with Disk-API-uploaded files.)
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
      const diskObjectId = uploaded?.ID ?? uploaded?.file?.ID;
      if (!diskObjectId) {
        throw new Error(`Unexpected upload response from Bitrix24: ${JSON.stringify(uploaded)}`);
      }

      // A freshly uploaded Disk object is sometimes not yet attachable -
      // tasks.task.files.attach intermittently returns "Access denied" (error
      // code 0) immediately after disk.folder.uploadfile, then succeeds a
      // moment later on the exact same call. That pattern (fails once, works
      // on retry, no config/scope change in between) points at Bitrix's Disk
      // ACL/indexing for the new object not yet being fully propagated when
      // the attach call lands - not a real permission problem. Retry a few
      // times with a short backoff instead of surfacing the transient error.
      const attachResult = await step("tasks.task.files.attach", async () => {
        const maxAttempts = 4;
        const baseDelayMs = 600;
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await callBitrix(employeeId, "tasks.task.files.attach", {
              taskId,
              fileId: diskObjectId,
            });
          } catch (err) {
            lastErr = err;
            const isAccessDenied = /Access denied/i.test(err.message);
            if (!isAccessDenied || attempt === maxAttempts) throw err;
            await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
          }
        }
        throw lastErr;
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ diskObjectId, attachResult }, null, 2) }],
      };
    }
  );

  server.tool(
    "bitrix_get_task",
    "Get full details of a single Bitrix24 task: description, comments, and attached files",
    { taskId: z.string() },
    async ({ taskId }) => {
      const taskResult = await callBitrix(employeeId, "tasks.task.get", {
        taskId,
        select: ["ID", "TITLE", "DESCRIPTION", "STATUS", "DEADLINE", "RESPONSIBLE_ID", "UF_TASK_WEBDAV_FILES"],
      });
      const task = taskResult?.task;
      if (!task) {
        throw new Error(`Unexpected response from tasks.task.get: ${JSON.stringify(taskResult)}`);
      }

      // task.commentitem.getlist is the classic (non-"tasks.") comments API;
      // there's no equivalent under tasks.task.* as of this Bitrix version.
      let comments = [];
      try {
        const commentsResult = await callBitrix(employeeId, "task.commentitem.getlist", [taskId]);
        comments = (commentsResult || []).map((c) => ({
          id: c.ID,
          author: c.AUTHOR_NAME,
          date: c.POST_DATE,
          text: c.POST_MESSAGE,
        }));
      } catch (err) {
        comments = [`Could not load comments: ${err.message}`];
      }

      const fileIds = task.ufTaskWebdavFiles ?? task.UF_TASK_WEBDAV_FILES ?? [];
      let files = [];
      if (fileIds.length) {
        files = await Promise.all(
          fileIds.map(async (fileId) => {
            try {
              const file = await callBitrix(employeeId, "disk.file.get", { id: fileId });
              return { id: fileId, name: file?.NAME, downloadUrl: file?.DOWNLOAD_URL };
            } catch (err) {
              return { id: fileId, error: err.message };
            }
          })
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: task.id ?? task.ID,
                title: task.title ?? task.TITLE,
                description: task.description ?? task.DESCRIPTION,
                status: task.status ?? task.STATUS,
                deadline: task.deadline ?? task.DEADLINE,
                comments,
                files,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "bitrix_read_attachment",
    "Download and read the content of a Bitrix24 Disk file (e.g. one attached to a task). Text files are returned as plain text, images as an image, other binary files as base64.",
    { fileId: z.string().describe("Disk file ID, e.g. from bitrix_get_task's files list") },
    async ({ fileId }) => {
      const file = await callBitrix(employeeId, "disk.file.get", { id: fileId });
      if (!file?.DOWNLOAD_URL) {
        throw new Error(`Could not get a download URL for file ${fileId}. Raw response: ${JSON.stringify(file)}`);
      }

      // DOWNLOAD_URL already carries its own auth token, so this is a plain
      // unauthenticated-from-our-side GET, not a callBitrix() REST call.
      const response = await axios.get(file.DOWNLOAD_URL, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data);
      const contentType = file.CONTENT_TYPE || response.headers["content-type"] || "application/octet-stream";

      if (contentType.startsWith("image/")) {
        return { content: [{ type: "image", data: buffer.toString("base64"), mimeType: contentType }] };
      }

      if (/^text\/|json|xml|csv/i.test(contentType)) {
        const MAX_CHARS = 20000;
        let text = buffer.toString("utf-8");
        if (text.length > MAX_CHARS) {
          text = `${text.slice(0, MAX_CHARS)}\n\n[truncated - file is ${buffer.length} bytes total]`;
        }
        return { content: [{ type: "text", text: `File: ${file.NAME} (${contentType})\n\n${text}` }] };
      }

      // Binary, non-image (PDF, docx, ...): base64 so Claude can still work with it.
      const MAX_BASE64_CHARS = 200000;
      let base64 = buffer.toString("base64");
      let note = "";
      if (base64.length > MAX_BASE64_CHARS) {
        base64 = base64.slice(0, MAX_BASE64_CHARS);
        note = ` [truncated - file is ${buffer.length} bytes total]`;
      }
      return {
        content: [{ type: "text", text: `File: ${file.NAME} (${contentType}), base64-encoded${note}:\n\n${base64}` }],
      };
    }
  );
}
