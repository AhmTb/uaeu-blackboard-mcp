import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { extractText, textWindow, htmlText } from "../dist/bb/extract.js";
import {
  publicAddress,
  resourceUrl,
  blackboardHost,
  inlineAttachments,
  linksFrom,
} from "../dist/bb/resources.js";
import { linkTarget, readCourseLink } from "../dist/bb/links.js";
import {
  boundedMap,
  dateMillis,
  dubaiWindowEnd,
} from "../dist/tools/student.js";
const zip = (parts) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(parts).map(([k, v]) => [k, strToU8(v)]),
      ),
    ),
  );

test("PowerPoint uses presentation order and note relationships rather than numeric filenames", async () => {
  const bytes = zip({
    "ppt/presentation.xml":
      '<p:presentation><p:sldIdLst><p:sldId id="123" r:id="rId2"/><p:sldId id="124" r:id="rId1"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml":
      "<p:sld><a:p><a:r><a:t>Second &amp; final</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide2.xml":
      "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
    "ppt/slides/_rels/slide2.xml.rels":
      '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide8.xml"/></Relationships>',
    "ppt/notesSlides/notesSlide8.xml":
      "<p:notes><a:p><a:r><a:t>Teacher note</a:t></a:r></a:p></p:notes>",
  });
  const result = await extractText(bytes, "slides.pptx");
  assert.equal(result.format, "pptx (2 slides)");
  assert.match(
    result.text,
    /Slide 1 ---\nFirst\n\[Speaker notes\]\nTeacher note/,
  );
  assert.ok(
    result.text.indexOf("First") < result.text.indexOf("Second & final"),
  );
});
test("DOCX includes paragraph boundaries and footnotes", async () => {
  const result = await extractText(
    zip({
      "word/document.xml":
        "<w:document><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:document>",
      "word/footnotes.xml": "<w:p><w:t>Note</w:t></w:p>",
    }),
    "x.docx",
  );
  assert.match(result.text, /Hello\nWorld/);
  assert.match(result.text, /Note/);
});
test("XLSX honors sheet relations, shared strings, sparse cells and dates", async () => {
  const result = await extractText(
    zip({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Marks &amp; dates" sheetId="1" r:id="rel9"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rel9" Target="worksheets/sheet7.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>One, two</t></si></sst>",
      "xl/styles.xml":
        '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      "xl/worksheets/sheet7.xml":
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1" s="1"><v>25569</v></c></row></sheetData></worksheet>',
    }),
    "x.xlsx",
  );
  assert.match(result.text, /Marks & dates/);
  assert.match(result.text, /"One, two",,1970-01-01/);
});
test("notebooks expose code without executing it", async () => {
  const result = await extractText(
    Buffer.from(
      JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Lab"] },
          { cell_type: "code", source: ['throw new Error("never run")'] },
        ],
      }),
    ),
    "x.ipynb",
  );
  assert.match(result.text, /\[code\]/);
  assert.match(result.text, /never run/);
});
test("PDF text is returned by page", async () => {
  const stream = "BT /F1 12 Tf 50 100 Td (Lecture PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n ")
    .join(
      "\n",
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const result = await extractText(Buffer.from(pdf), "lecture.pdf");
  assert.equal(result.format, "pdf (1 pages)");
  assert.match(result.text, /Lecture PDF/);
});
test("Office archives with oversized XML are rejected before inflation", async () => {
  const bytes = zip({ "word/document.xml": "a".repeat(21 * 1024 * 1024) });
  await assert.rejects(
    () => extractText(bytes, "large.docx"),
    /expanded text size/,
  );
});
test("unposted URLs are rejected before making a resource request", async () => {
  let fetched = false;
  const client = {
    config: { baseUrl: "https://uaeu.blackboard.com" },
    readResource: async () => {
      fetched = true;
      throw Error("should not fetch");
    },
  };
  const reader = {
    content: async () => ({
      item: {
        body: { rawText: '<a href="https://example.com/reading">Reading</a>' },
      },
    }),
  };
  await assert.rejects(
    () =>
      readCourseLink(client, reader, {
        courseId: "_1_1",
        contentId: "_2_1",
        url: "https://evil.example/",
      }),
    /not found/,
  );
  assert.equal(fetched, false);
});
test("HTML strips scripts and decodes text once", () =>
  assert.equal(htmlText("<script>secret()</script><p>A &amp; B</p>"), "A & B"));
test("long text has explicit continuation boundaries", () => {
  assert.deepEqual(textWindow("abcdefgh", 2, 3), {
    text: "cde",
    offset: 2,
    totalChars: 8,
    nextOffset: 5,
  });
  assert.equal(textWindow("abc", 999).nextOffset, null);
});
test("unsupported files state their limits", async () => {
  const result = await extractText(
    Buffer.from([137, 80, 78, 71]),
    "x.png",
    "image/png",
  );
  assert.equal(result.text, "");
  assert.ok(result.limitations.length);
});
test("local, mapped IPv6 and reserved IPs are refused", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
test("URLs disallow credentials, non-HTTPS, local names and custom ports", () => {
  for (const url of [
    "http://example.com",
    "https://u:p@example.com",
    "https://localhost",
    "https://example.com:8443",
    "file:///x",
  ])
    assert.throws(() => resourceUrl(url));
});
test("Blackboard alternate hosts cannot be spoofed by suffixes", () => {
  assert.equal(
    blackboardHost(
      new URL("https://alt-123abc.blackboard.com/x"),
      "https://uaeu.blackboard.com",
    ),
    true,
  );
  assert.equal(
    blackboardHost(
      new URL("https://alt-123abc.blackboard.com.evil.com/x"),
      "https://uaeu.blackboard.com",
    ),
    false,
  );
});
test("Ultra inline file metadata resolves to a real download URL", () => {
  const result = inlineAttachments(
    {
      contentDetail: {
        "resource/x-bb-file": {
          file: {
            fileName: "lecture.pptx",
            permanentUrl: "/bbcswebdav/x",
            existingFileReference: "file1",
          },
        },
      },
    },
    "https://uaeu.blackboard.com",
  );
  assert.equal(result[0].fileId, "file1");
  assert.equal(result[0].url, "https://uaeu.blackboard.com/bbcswebdav/x");
});
test("posted links include HTML anchors and embedded links", () => {
  const links = linksFrom(
    {
      body: {
        rawText: '<a href="https://example.com/?x=1&amp;y=2">Reading</a>',
      },
    },
    "https://uaeu.blackboard.com",
  );
  assert.equal(links[0].url, "https://example.com/?x=1&y=2");
  assert.equal(links[0].label, "Reading");
});
test("assignment instruction links and iframe siblings are discovered", () => {
  const links = linksFrom(
    {
      contentDetail: {
        "resource/x-bb-asmt-test-link": {
          test: {
            instructions: {
              rawText:
                '<iframe src="https://example.com/video"></iframe><a href="/bbcswebdav/brief.pdf">Brief</a>',
            },
          },
        },
      },
    },
    "https://uaeu.blackboard.com",
  );
  assert.equal(links.length, 2);
  assert.equal(links[1].label, "Brief");
});
test("Google and Colab are converted to downloadable resources", () => {
  assert.match(
    linkTarget("https://docs.google.com/presentation/d/abc/edit").url,
    /export\?format=pptx$/,
  );
  assert.equal(
    linkTarget("https://colab.research.google.com/github/a/b/main/lab.ipynb")
      .url,
    "https://raw.githubusercontent.com/a/b/main/lab.ipynb",
  );
});
test("Dubai due-day boundary and date numbers are preserved", () => {
  assert.equal(
    new Date(
      dubaiWindowEnd(Date.parse("2026-11-13T15:00:00Z"), 7),
    ).toISOString(),
    "2026-11-20T19:59:59.999Z",
  );
  assert.equal(dateMillis(1794206120843), 1794206120843);
  assert.equal(dateMillis("1794206120843"), 1794206120843);
});
test("parallel course reads remain bounded and ordered", async () => {
  let active = 0,
    peak = 0;
  const result = await boundedMap([1, 2, 3, 4], 2, async (i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return i * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.ok(peak <= 2);
});
