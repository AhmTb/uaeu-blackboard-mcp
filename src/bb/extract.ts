import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const MAX_TEXT = 2_000_000;
const MAX_EXPANDED = 100 * 1024 * 1024;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
});
export interface ExtractedText {
  text: string;
  format: string;
  limitations: string[];
}

export function decodeText(value: string): string {
  return value.replace(
    /&#(x[0-9a-f]+|\d+);|&(lt|gt|amp|quot|apos|nbsp);/gi,
    (whole, code: string, name: string) => {
      if (code) {
        const n =
          code[0]?.toLowerCase() === "x"
            ? parseInt(code.slice(1), 16)
            : Number(code);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
      }
      return (
        (
          {
            lt: "<",
            gt: ">",
            amp: "&",
            quot: '"',
            apos: "'",
            nbsp: " ",
          } as Record<string, string>
        )[name.toLowerCase()] ?? whole
      );
    },
  );
}
export function htmlText(html: string): string {
  return decodeText(
    html
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(?:p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .trim();
}
function xmlText(xml: string): string {
  return decodeText(
    xml
      .replace(/<\/(?:\w+:)?p>/g, "\n")
      .replace(/<(?:\w+:)?(?:tab)\s*\/>/g, "\t")
      .replace(/<(?:\w+:)?br\s*\/>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}
function array<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
function cellText(v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "object") return String(v);
  if ("#text" in v) return String(v["#text"]);
  if (v.t !== undefined) return cellText(v.t);
  return array(v.r)
    .map((r: any) => cellText(r.t))
    .join("");
}
function csv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function textWindow(text: string, offset = 0, size = 20000) {
  const start = Math.min(Math.max(0, Math.floor(offset)), text.length);
  const end = Math.min(
    text.length,
    start + Math.max(1, Math.min(50000, Math.floor(size))),
  );
  return {
    text: text.slice(start, end),
    offset: start,
    totalChars: text.length,
    nextOffset: end < text.length ? end : null,
  };
}

export async function extractText(
  bytes: Buffer,
  fileName = "",
  mimeType = "",
): Promise<ExtractedText> {
  const ext = path.extname(fileName).toLowerCase();
  const limitations: string[] = [];
  let text = "",
    format = ext.slice(1) || mimeType || "unknown";
  if (bytes.length > 50 * 1024 * 1024)
    throw new Error("File exceeds 50 MiB extraction limit.");
  if (bytes.subarray(0, 5).toString() === "%PDF-" || ext === ".pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    try {
      const result = await pdfText(pdf, { mergePages: false });
      const pages = result.text as string[];
      text = pages
        .map((page, i) => `--- Page ${i + 1} ---\n${page}`)
        .join("\n\n");
      format = `pdf (${result.totalPages} pages)`;
      const empty = pages.filter((p) => !p.trim()).length;
      if (empty)
        limitations.push(
          `${empty} pages have no text layer. Image-only pages require OCR; no OCR was performed.`,
        );
    } finally {
      await (pdf as any).destroy?.();
    }
  } else if (ext === ".ipynb") {
    const notebook = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(notebook.cells))
      throw new Error("Notebook has no cells.");
    text = notebook.cells
      .map((cell: any) => {
        const source = Array.isArray(cell.source)
          ? cell.source.join("")
          : String(cell.source ?? "");
        return cell.cell_type === "code" ? `[code]\n${source}` : source;
      })
      .join("\n\n");
    format = "jupyter notebook";
    limitations.push(
      "Code is displayed only; cells were not executed. Outputs and embedded images are omitted.",
    );
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let expanded = 0;
    const files = unzipSync(bytes, {
      filter: (entry) => {
        if (!/^(ppt|word|xl)\/.*\.(xml|rels)$/.test(entry.name)) return false;
        expanded += entry.originalSize;
        if (entry.originalSize > 20 * 1024 * 1024 || expanded > MAX_EXPANDED)
          throw new Error("Office archive exceeds expanded text size limit.");
        return true;
      },
    });
    const read = (name: string): string =>
      files[name] ? strFromU8(files[name]!) : "";
    const doc = (name: string): any => parser.parse(read(name));
    if (files["ppt/presentation.xml"]) {
      const rels = new Map<string, string>(
        array<any>(
          doc("ppt/_rels/presentation.xml.rels").Relationships?.Relationship,
        )
          .filter((r) => r["@TargetMode"] !== "External")
          .map((r) => [r["@Id"], path.posix.normalize(`ppt/${r["@Target"]}`)]),
      );
      const slides = array<any>(
        doc("ppt/presentation.xml").presentation?.sldIdLst?.sldId,
      );
      text = slides
        .map((slide, i) => {
          const name = rels.get(slide["@id"]);
          if (!name || !files[name])
            throw new Error(`Missing slide part ${i + 1}`);
          const slideRels = doc(
            path.posix.join(
              path.posix.dirname(name),
              "_rels",
              path.posix.basename(name) + ".rels",
            ),
          );
          const notesRel = array<any>(
            slideRels.Relationships?.Relationship,
          ).find(
            (r) =>
              /\/notesSlide$/.test(r["@Type"]) &&
              r["@TargetMode"] !== "External",
          );
          const notes = notesRel
            ? read(
                path.posix.normalize(
                  path.posix.join(
                    path.posix.dirname(name),
                    notesRel["@Target"],
                  ),
                ),
              )
            : "";
          return `--- Slide ${i + 1} ---\n${xmlText(read(name))}${notes ? `\n[Speaker notes]\n${xmlText(notes)}` : ""}`;
        })
        .join("\n\n");
      format = `pptx (${slides.length} slides)`;
      limitations.push(
        "Text and speaker notes extracted. Diagrams, images, animations and visual layout are not interpreted.",
      );
    } else if (files["word/document.xml"]) {
      text = [
        "word/document.xml",
        ...Object.keys(files).filter((n) =>
          /^word\/(footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(n),
        ),
      ]
        .map((n) => xmlText(read(n)))
        .join("\n\n");
      format = "docx";
    } else if (files["xl/workbook.xml"]) {
      const workbook = doc("xl/workbook.xml").workbook;
      const rels = new Map<string, string>(
        array<any>(
          doc("xl/_rels/workbook.xml.rels").Relationships?.Relationship,
        )
          .filter((r) => r["@TargetMode"] !== "External")
          .map((r) => [
            r["@Id"],
            r["@Target"].startsWith("/")
              ? r["@Target"].slice(1)
              : path.posix.normalize(`xl/${r["@Target"]}`),
          ]),
      );
      const strings = array<any>(doc("xl/sharedStrings.xml").sst?.si).map(
        cellText,
      );
      const styles = doc("xl/styles.xml").styleSheet;
      const custom = new Map<number, string>(
        array<any>(styles?.numFmts?.numFmt).map((v) => [
          Number(v["@numFmtId"]),
          v["@formatCode"],
        ]),
      );
      const xfs = array<any>(styles?.cellXfs?.xf);
      const date1904 = ["1", "true"].includes(
        String(workbook.workbookPr?.["@date1904"]),
      );
      const sheets = array<any>(workbook.sheets?.sheet);
      let sheetCharacters = 0;
      text = sheets
        .map((sheet) => {
          const target = rels.get(sheet["@id"]);
          if (!target || !files[target])
            throw new Error("Spreadsheet worksheet is missing.");
          const rows: string[] = [];
          for (const row of array<any>(doc(target).worksheet?.sheetData?.row)) {
            if (sheetCharacters >= MAX_TEXT) {
              limitations.push(
                "Spreadsheet text truncated at the document text limit.",
              );
              break;
            }
            const cells: string[] = [];
            for (const c of array<any>(row.c)) {
              const letters = String(c["@r"] ?? "").match(/^[A-Z]+/)?.[0];
              let col = letters
                ? [...letters].reduce(
                    (n, ch) => n * 26 + ch.charCodeAt(0) - 64,
                    0,
                  ) - 1
                : cells.length;
              if (col > 16383) throw new Error("Invalid worksheet column.");
              while (cells.length < col) cells.push("");
              let v =
                c["@t"] === "s"
                  ? (strings[Number(c.v)] ?? "")
                  : c["@t"] === "inlineStr"
                    ? cellText(c.is)
                    : cellText(c.v);
              const style = Number(xfs[Number(c["@s"])]?.["@numFmtId"]);
              const code =
                custom
                  .get(style)
                  ?.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")
                  .toLowerCase() ?? "";
              if (
                (c["@t"] === undefined || c["@t"] === "n") &&
                v !== "" &&
                Number.isFinite(Number(v)) &&
                ((style >= 14 && style <= 22) || /[dyh]/.test(code))
              ) {
                const iso = new Date(
                  Math.round(
                    (Number(v) - (date1904 ? 24107 : 25569)) * 86400000,
                  ),
                ).toISOString();
                v =
                  (style >= 18 && style <= 21) ||
                  (!/[dy]/.test(code) && /h/.test(code))
                    ? iso.slice(11, 19)
                    : style === 22 || (/[dy]/.test(code) && /h/.test(code))
                      ? iso.replace("T", " ").slice(0, 19)
                      : iso.slice(0, 10);
              }
              cells[col] = csv(v);
            }
            const rowText = cells.join(",");
            sheetCharacters += rowText.length;
            rows.push(rowText);
          }
          return `--- Sheet: ${decodeText(sheet["@name"])} ---\n${rows.join("\n")}`;
        })
        .join("\n\n");
      format = `xlsx (${sheets.length} sheets)`;
      limitations.push(
        "Formula cached values are shown; formulas are not recalculated. Formatting and charts are omitted.",
      );
    } else
      limitations.push(
        "ZIP archive is not a supported Office document. Contents were not executed or extracted to disk.",
      );
  } else if (ext === ".html" || /text\/html/.test(mimeType)) {
    text = htmlText(bytes.toString("utf8"));
    format = "html";
  } else if (
    /^text\//.test(mimeType) ||
    /\.(txt|md|csv|tsv|json|xml|py|java|js|ts|c|cpp|h|r|sql|yml|yaml|srt|vtt|log)$/i.test(
      fileName,
    ) ||
    /application\/(json|xml)/.test(mimeType)
  ) {
    text = bytes.toString("utf8");
  } else
    limitations.push(
      "No text extractor for this format. Images, scanned documents and legacy Office files need a separate reader.",
    );
  if (text.length > MAX_TEXT)
    limitations.push(`Text truncated at ${MAX_TEXT} characters.`);
  return { text: text.slice(0, MAX_TEXT), format, limitations };
}
