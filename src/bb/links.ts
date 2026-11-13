import { resourceUrl, linksFrom, type CourseReader } from "./resources.js";
import { htmlText } from "./extract.js";
import type { BlackboardClient } from "./client.js";

export function linkTarget(value: string): {
  url: string;
  fileName?: string;
  kind: string;
} {
  const u = resourceUrl(value);
  if (u.hostname === "docs.google.com") {
    const match = /^\/(document|presentation|spreadsheets)\/d\/([\w-]+)/.exec(
      u.pathname,
    );
    if (match) {
      const [, type, id] = match;
      const format =
        type === "document" ? "txt" : type === "presentation" ? "pptx" : "xlsx";
      return {
        url: `https://docs.google.com/${type}/d/${id}/export?format=${format}`,
        fileName: `${id}.${format}`,
        kind: `google ${type}`,
      };
    }
  }
  if (u.hostname === "colab.research.google.com") {
    const github = /^\/github\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (github)
      return {
        url: `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${github[3]}`,
        fileName: "notebook.ipynb",
        kind: "colab notebook",
      };
    const drive = /^\/drive\/([\w-]+)/.exec(u.pathname);
    if (drive)
      return {
        url: `https://drive.google.com/uc?export=download&id=${drive[1]}`,
        fileName: "notebook.ipynb",
        kind: "colab notebook",
      };
  }
  if (u.hostname === "drive.google.com") {
    const id =
      /^\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get("id");
    if (id)
      return {
        url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,
        kind: "google drive",
      };
  }
  if (["youtube.com", "www.youtube.com", "youtu.be"].includes(u.hostname))
    return { url: u.href, kind: "youtube video" };
  if (/(^|\.)zoom\.us$/.test(u.hostname))
    return { url: u.href, kind: "zoom recording" };
  return { url: u.href, kind: "web resource" };
}

export async function readCourseLink(
  client: BlackboardClient,
  reader: CourseReader,
  args: {
    courseId: string;
    url: string;
    contentId?: string;
    announcementId?: string;
  },
) {
  const requested = resourceUrl(args.url).href;
  const { BlackboardApi } = await import("./api.js");
  const api = new BlackboardApi(client);
  const course = await api.resolveCourse(args.courseId);
  let allowed = false;
  if (args.contentId) {
    const { item } = await reader.content(course, args.contentId);
    allowed = linksFrom(item, client.config.baseUrl).some(
      (l) => l.url === requested,
    );
  } else if (args.announcementId) {
    const announcement = await client.get<Record<string, any>>(
      `/courses/${encodeURIComponent(course)}/announcements/${encodeURIComponent(args.announcementId)}`,
    );
    allowed = linksFrom(announcement, client.config.baseUrl).some(
      (l) => l.url === requested,
    );
  } else {
    const items = await api.walkContent(course);
    allowed = items.some((i) =>
      linksFrom(i, client.config.baseUrl).some((l) => l.url === requested),
    );
    if (!allowed) {
      const announcements = await api.announcements(course, 100);
      allowed = announcements.some((i) =>
        linksFrom(i, client.config.baseUrl).some((l) => l.url === requested),
      );
    }
  }
  if (!allowed)
    throw new Error(
      "URL was not found on this course source. Supply its contentId or announcementId from Blackboard.",
    );
  const target = linkTarget(requested);
  if (target.kind === "youtube video") {
    const metadata = await client.readResource(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(requested)}&format=json`,
    );
    const info = JSON.parse(metadata.bytes.toString("utf8"));
    return {
      url: requested,
      kind: target.kind,
      format: "video metadata",
      fileName: "YouTube",
      text: `Title: ${info.title}\nChannel: ${info.author_name}`,
      limitations: [
        "YouTube transcript is not available through this reader. This is metadata, not the video contents.",
      ],
    };
  }
  // Inspect login HTML before passing a Google export to a JSON/Office parser.
  const resource = await client.readResource(target.url);
  if (
    resource.mimeType === "text/html" &&
    (target.fileName ||
      new URL(resource.url).hostname === "accounts.google.com" ||
      /\/login|\/signin/.test(new URL(resource.url).pathname))
  ) {
    return {
      url: requested,
      kind: target.kind,
      format: "sign-in required",
      fileName: resource.fileName,
      text: "",
      limitations: [
        "The site returned a sign-in or access page. Connect this site with the CLI connect command, then retry. Google may block automated sign-in; publicly shared files work without it.",
      ],
    };
  }
  const result = await reader.read(
    target.url,
    target.fileName,
    false,
    resource,
  );
  if (resource.mimeType === "text/html") {
    const html = resource.bytes.toString("utf8");
    const title = htmlText(
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "",
    );
    const track = /<track\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html)?.[1];
    if (track) {
      const captionUrl = resourceUrl(track, resource.url);
      if (captionUrl.origin === new URL(resource.url).origin) {
        const captions = await reader.read(captionUrl.href, "captions.vtt");
        return {
          ...captions,
          url: requested,
          kind: target.kind,
          title,
          format: "video captions",
          limitations: [
            ...captions.limitations,
            "Captions only; visuals are not interpreted.",
          ],
        };
      }
    }
    return {
      ...result,
      url: requested,
      kind: target.kind,
      title,
      limitations: [
        ...result.limitations,
        "Only server-rendered page text is available. Interactive tools and protected video transcripts may require their own site login.",
      ],
    };
  }
  return { ...result, url: requested, kind: target.kind };
}
