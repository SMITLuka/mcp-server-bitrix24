import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function kindOf(name = "", contentType = "") {
  const lower = name.toLowerCase();
  if (contentType === XLSX_TYPE || lower.endsWith(".xlsx")) return "xlsx";
  if (contentType === DOCX_TYPE || lower.endsWith(".docx")) return "docx";
  if (contentType === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  return null;
}

async function xlsxToText(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const parts = [];
  workbook.eachSheet((sheet) => {
    const lines = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        // cell.text gives the displayed value, including formula results and rich text.
        cells[col - 1] = cell.text ?? "";
      });
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) lines.push(cells.map((c) => c ?? "").join(" | "));
    });
    parts.push(`=== Sheet "${sheet.name}" (${lines.length} non-empty rows) ===\n${lines.join("\n")}`);
  });
  return parts.join("\n\n");
}

async function docxToText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

async function pdfToText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const { text } = await parser.getText();
    return text;
  } finally {
    await parser.destroy();
  }
}

// Returns { kind, text } for xlsx/docx/pdf, or null for other types. Throws if
// the file claims to be one of these but can't be parsed (corrupt, encrypted).
export async function extractDocumentText(buffer, name, contentType) {
  const kind = kindOf(name, contentType);
  if (!kind) return null;
  const extract = { xlsx: xlsxToText, docx: docxToText, pdf: pdfToText }[kind];
  return { kind, text: await extract(buffer) };
}
