import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BlackboardClient } from "./client.js";
import { BlackboardApi } from "./api.js";
import { decodeText, extractText, type ExtractedText } from "./extract.js";

export interface Resource {
  bytes: Buffer;
  url: string;
  mimeType: string;
  fileName: string;
}
export interface Attachment {
  fileId?: string;
  fileName: string;
  mimeType?: string;
  size?: number;
  url: string;
}
export const MAX_DOWNLOAD = 50 * 1024 * 1024;
export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function resourceUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "Only HTTPS resources on port 443 without URL credentials are supported.",
    );
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal")
  )
    throw new Error("Local network resources are not allowed.");
  return url;
}
export function blackboardHost(url: URL, base: string): boolean {
  return (
    url.origin === new URL(base).origin ||
    (new URL(base).hostname.endsWith(".blackboard.com") &&
      /^alt-[a-f\d]+\.blackboard\.com$/i.test(url.hostname))
  );
}

/** DNS is resolved and pinned for each HTTPS hop, including redirects. */
export async function fetchResource(
  value: string,
  options: {
    baseUrl: string;
    timeoutMs: number;
    cookieFor?: (url: string) => string;
    blackboardOnly?: boolean;
  },
): Promise<Resource> {
  let url = resourceUrl(value, options.baseUrl);
  const deadline = Date.now() + options.timeoutMs;
  for (let hop = 0; hop < 6; hop++) {
    if (options.blackboardOnly && !blackboardHost(url, options.baseUrl))
      throw new Error("Course file redirected outside Blackboard.");
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
      all: true,
    });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new Error("Resource resolves to a non-public address.");
    const pinned = addresses[0]!;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Resource download timed out.");
    const cookie = options.cookieFor?.(url.href);
    const result = await new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      bytes: Buffer;
    }>((resolve, reject) => {
      const req = https.get(
        url,
        {
          headers: {
            "user-agent": "uaeu-blackboard-mcp/0.2",
            accept: "*/*",
            ...(cookie ? { cookie } : {}),
          },
          lookup: ((_host: unknown, opts: any, cb: any) =>
            opts?.all
              ? cb(null, [pinned])
              : cb(null, pinned.address, pinned.family)) as any,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            resolve({ status, headers: res.headers, bytes: Buffer.alloc(0) });
            return;
          }
          if (/^(video|audio)\//.test(String(res.headers["content-type"]))) {
            res.destroy();
            resolve({ status, headers: res.headers, bytes: Buffer.alloc(0) });
            return;
          }
          if (Number(res.headers["content-length"]) > MAX_DOWNLOAD) {
            res.destroy(new Error("Resource exceeds 50 MiB download limit."));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_DOWNLOAD)
              res.destroy(new Error("Resource exceeds 50 MiB download limit."));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status,
              headers: res.headers,
              bytes: Buffer.concat(chunks),
            }),
          );
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("Resource download timed out.")),
        remaining,
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
    });
    if (
      result.status >= 300 &&
      result.status < 400 &&
      result.headers.location
    ) {
      url = resourceUrl(result.headers.location, url.href);
      continue;
    }
    if (result.status === 401 || result.status === 403)
      throw new Error(
        "This resource requires sign-in or your account does not have access.",
      );
    if (result.status < 200 || result.status >= 300)
      throw new Error(`Resource returned HTTP ${result.status}.`);
    const disposition = result.headers["content-disposition"] ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
    let fileName =
      plain?.[1] ?? plain?.[2]?.trim() ?? path.posix.basename(url.pathname);
    if (encoded) {
      try {
        fileName = decodeURIComponent(encoded);
      } catch {
        /* Keep plain filename. */
      }
    }
    return {
      bytes: result.bytes,
      url: url.href,
      mimeType: String(result.headers["content-type"] ?? "").split(";")[0]!,
      fileName,
    };
  }
  throw new Error("Resource exceeded five redirects.");
}

export function linksFrom(
  item: Record<string, any>,
  base: string,
): Array<{ url: string; label: string }> {
  const found = new Map<string, string>();
  const add = (url: unknown, label = "") => {
    if (typeof url !== "string") return;
    try {
      const parsed = resourceUrl(decodeText(url), base);
      if (label || !found.has(parsed.href)) found.set(parsed.href, label);
    } catch {
      /* Unsupported link. */
    }
  };
  const scan = (html: unknown) => {
    if (html && typeof html === "object") {
      const body = html as Record<string, unknown>;
      html = body.rawText ?? body.formattedText ?? body.displayText;
    }
    if (typeof html !== "string") return;
    for (const m of html.matchAll(
      /<(?:a|iframe|video|source)\b[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi,
    ))
      add(m[1]);
    for (const m of html.matchAll(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    ))
      add(m[1], decodeText((m[2] ?? "").replace(/<[^>]*>/g, "")).trim());
    for (const m of html.matchAll(/https:\/\/[^\s<>"']+/g))
      add(m[0].replace(/[),.;]+$/, ""));
  };
  scan(item.description);
  scan(
    typeof item.body === "string"
      ? item.body
      : (item.body?.rawText ??
          item.body?.formattedText ??
          item.body?.displayText),
  );
  for (const detail of Object.values(item.contentDetail ?? {}) as any[]) {
    add(detail?.url, item.title);
    scan(detail?.instructions);
    scan(detail?.test?.instructions);
  }
  if (typeof item.contentHandler === "object") {
    add(item.contentHandler.url, item.title);
    scan(item.contentHandler.instructions);
  }
  return [...found].map(([url, label]) => ({ url, label }));
}

export function inlineAttachments(
  item: Record<string, any>,
  base: string,
): Attachment[] {
  const out: Attachment[] = [];
  const add = (file: any) => {
    if (!file || typeof file !== "object") return;
    const url =
      file.permanentUrl ?? file.downloadUrl ?? file.url ?? file.viewerUrl;
    if (typeof url !== "string") return;
    out.push({
      fileId: file.id ?? file.fileId ?? file.existingFileReference,
      fileName: file.fileName ?? file.name ?? "attachment",
      mimeType: file.mimeType,
      size: file.fileSize ?? file.size,
      url: new URL(url, base).href,
    });
  };
  for (const detail of Object.values(item.contentDetail ?? {}) as any[]) {
    add(detail?.file);
    for (const f of detail?.attachments ?? []) add(f);
  }
  add(item.contentHandler?.file);
  for (const file of item.attachments ?? []) add(file);
  for (const link of linksFrom(item, base))
    if (new URL(link.url).pathname.startsWith("/bbcswebdav/"))
      add({
        url: link.url,
        fileName: link.label || path.posix.basename(new URL(link.url).pathname),
      });
  return [...new Map(out.map((f) => [f.url, f])).values()];
}

export class CourseReader {
  private readonly api: BlackboardApi;
  private readonly cache = new Map<
    string,
    {
      expires: number;
      value: ExtractedText & {
        savedPath?: string;
        fileName: string;
        url: string;
      };
    }
  >();
  constructor(private readonly client: BlackboardClient) {
    this.api = new BlackboardApi(client);
  }
  async content(courseId: string, contentId: string) {
    const course = await this.api.resolveCourse(courseId);
    const item = await this.client.get<Record<string, any>>(
      `/courses/${encodeURIComponent(course)}/contents/${encodeURIComponent(contentId)}`,
    );
    return { courseId: course, item };
  }
  async attachments(courseId: string, contentId: string) {
    const { courseId: course, item } = await this.content(courseId, contentId);
    let files = inlineAttachments(item, this.client.config.baseUrl);
    if (!files.length) {
      try {
        const page = await this.client.get<any>(
          `/courses/${encodeURIComponent(course)}/contents/${encodeURIComponent(contentId)}/attachments`,
        );
        files = inlineAttachments(
          { attachments: Array.isArray(page) ? page : (page.results ?? []) },
          this.client.config.baseUrl,
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          "status" in error &&
          [403, 404].includes(Number(error.status))
        ))
          throw error;
      }
    }
    return {
      courseId: course,
      contentId,
      title: item.title,
      files,
      links: linksFrom(item, this.client.config.baseUrl),
    };
  }
  async attachment(courseId: string, contentId: string, fileId?: string) {
    const listing = await this.attachments(courseId, contentId);
    const file = fileId
      ? listing.files.find((f) => f.fileId === fileId || f.fileName === fileId)
      : listing.files.length === 1
        ? listing.files[0]
        : undefined;
    if (!file)
      throw new Error(
        listing.files.length
          ? `Choose fileId or fileName from bb_list_attachments (${listing.files.length} available).`
          : "No downloadable attachment found on this content item.",
      );
    const url = resourceUrl(file.url);
    if (!blackboardHost(url, this.client.config.baseUrl))
      throw new Error(
        "External attachment: use bb_read_link with its course source.",
      );
    return { ...listing, ...(await this.read(url.href, file.fileName, true)) };
  }
  async read(
    url: string,
    name?: string,
    blackboardOnly = false,
    preloaded?: Resource,
  ) {
    const key = `${blackboardOnly}:${url}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const resource =
      preloaded ?? (await this.client.readResource(url, blackboardOnly));
    const fileName = name ?? resource.fileName;
    const extracted = await extractText(
      resource.bytes,
      fileName,
      resource.mimeType,
    );
    let savedPath: string | undefined;
    if (
      (blackboardOnly || resource.mimeType !== "text/html") &&
      !/^(video|audio)\//.test(resource.mimeType)
    ) {
      const digest = createHash("sha256")
        .update(resource.bytes)
        .digest("hex")
        .slice(0, 16);
      const safeName =
        path
          .basename(fileName.replace(/\\/g, "/"))
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
          .slice(0, 150) || "attachment";
      savedPath = path.join(
        this.client.config.downloadDir,
        `${digest}-${safeName}`,
      );
      await fs.mkdir(this.client.config.downloadDir, { recursive: true });
      try {
        await fs.writeFile(savedPath, resource.bytes, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const value = { ...extracted, savedPath, fileName, url: resource.url };
    if (this.cache.size >= 12)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { expires: Date.now() + 10 * 60_000, value });
    return value;
  }
}
