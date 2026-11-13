import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../index.js";
import { BlackboardApi } from "../bb/api.js";
import { inlineAttachments, linksFrom } from "../bb/resources.js";
import { json, tool } from "./util.js";

export function dateMillis(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value) return NaN;
  return /^\d{12,}$/.test(value) ? Number(value) : Date.parse(value);
}
export async function boundedMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        result[i] = await fn(items[i]!);
      }
    }),
  );
  return result;
}
export function dubaiWindowEnd(now: number, days: number): number {
  const offset = 4 * 3600_000;
  const date = new Date(now + days * 86400_000 + offset);
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) -
    offset -
    1
  );
}
export function registerStudentTools(
  server: McpServer,
  context: ToolContext,
): void {
  const api = new BlackboardApi(context.client);
  const annotations = { readOnlyHint: true, openWorldHint: false };
  const courseSchema = {
    courseId: z
      .string()
      .optional()
      .describe("Omit to check up to 20 available courses"),
  };
  async function courses(courseId?: string) {
    if (courseId) {
      const id = await api.resolveCourse(courseId);
      return { items: [{ id, name: courseId }], skipped: 0 };
    }
    const all = (await api.courses())
      .filter((c) => c.available !== false && !c.organization)
      .sort(
        (a, b) =>
          Number(b.id.match(/\d+/)?.[0]) - Number(a.id.match(/\d+/)?.[0]),
      );
    return { items: all.slice(0, 20), skipped: Math.max(0, all.length - 20) };
  }
  server.registerTool(
    "bb_get_upcoming_work",
    {
      title: "Get upcoming work across courses",
      description:
        "Assignments due soon across courses, submission status, recently overdue items and undated counts. Default seven days ahead through end of the last day in Asia/Dubai, plus three days overdue. Unknown submission status never means confirmed missing work.",
      inputSchema: {
        ...courseSchema,
        days: z.number().int().min(1).max(90).optional(),
      },
      annotations,
    },
    tool(async ({ courseId, days = 7 }) => {
      const selected = await courses(courseId),
        now = Date.now(),
        until = dubaiWindowEnd(now, days);
      const limitations = ["Only deadlines posted in Blackboard are included."];
      const batches = await boundedMap(
        selected.items,
        context.client.config.concurrency ?? 4,
        async (course) => {
          try {
            return (await api.assignments(course.id)).map((item) => ({
              ...item,
              courseId: course.id,
              courseName: course.name,
              submissionStatus: item.submissionStatus ?? "unknown",
            }));
          } catch (error) {
            limitations.push(`${course.name}: ${(error as Error).message}`);
            return [];
          }
        },
      );
      const all = batches.flat(),
        undated = all.filter(
          (i) => !Number.isFinite(dateMillis(i.dueDate)),
        ).length;
      const items = all
        .filter((i) => {
          const t = dateMillis(i.dueDate);
          return t >= now && t <= until;
        })
        .sort((a, b) => dateMillis(a.dueDate) - dateMillis(b.dueDate));
      const recentlyOverdue = all.filter((i) => {
        const t = dateMillis(i.dueDate);
        return (
          t < now &&
          t >= now - 3 * 86400_000 &&
          !["submitted", "graded"].includes(i.submissionStatus)
        );
      });
      if (selected.skipped)
        limitations.push(`${selected.skipped} older courses were not checked.`);
      if (undated)
        limitations.push(
          `${undated} assignments have no valid posted due date.`,
        );
      if (
        [...items, ...recentlyOverdue].some(
          (i) => i.submissionStatus === "unknown",
        )
      )
        limitations.push(
          "Some submission states are unknown. Unknown does not mean not submitted.",
        );
      return json({
        timeZone: "Asia/Dubai",
        from: new Date(now).toISOString(),
        until: new Date(until).toISOString(),
        courseCount: selected.items.length,
        items,
        recentlyOverdue,
        undated,
        limitations,
      });
    }),
  );
  server.registerTool(
    "bb_get_recent_updates",
    {
      title: "Get recent course updates",
      description:
        "New or changed content, announcements, assignments and grades on recently modified gradebook columns. Default last seven days. Dates, files and links identify latest lectures for bb_get_attachment. Grades on older unchanged columns may be missed.",
      inputSchema: {
        ...courseSchema,
        since: z
          .string()
          .optional()
          .describe(
            "ISO date or timestamp; date alone means midnight Asia/Dubai",
          ),
      },
      annotations,
    },
    tool(async ({ courseId, since }) => {
      const value =
        since && /^\d{4}-\d{2}-\d{2}$/.test(since)
          ? since + "T00:00:00+04:00"
          : since;
      const from = value ? dateMillis(value) : Date.now() - 7 * 86400_000;
      if (!Number.isFinite(from))
        throw new Error("since must be a valid ISO date or timestamp.");
      const selected = await courses(courseId),
        limitations: string[] = [];
      const perCourse = await boundedMap(
        selected.items,
        context.client.config.concurrency ?? 4,
        async (course) => {
          const [content, announcements, columns, grades] =
            await Promise.allSettled([
              api.walkContent(course.id),
              context.client.getAll<Record<string, any>>(
                `/courses/${encodeURIComponent(course.id)}/announcements`,
              ),
              api.gradeColumns(course.id),
              api.myGrades(course.id),
            ]);
          const source = <T>(
            r: PromiseSettledResult<T[]>,
            name: string,
          ): T[] => {
            if (r.status === "fulfilled") return r.value;
            limitations.push(
              `${course.name} ${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
            );
            return [];
          };
          const items = source(content, "content"),
            anns = source(announcements, "announcements"),
            cols = source(columns, "columns"),
            cells = source(grades, "grades");
          const tag = { courseId: course.id, courseName: course.name };
          const changed = items.filter(
            (i) =>
              dateMillis(
                i.modifiedDate ?? i.modified ?? i.createdDate ?? i.created,
              ) >= from,
          );
          return {
            content: changed.map((i) => ({
              ...tag,
              id: i.id,
              title: i.title,
              handler: i.contentHandler,
              modifiedDate: i.modifiedDate ?? i.modified,
              createdDate: i.createdDate ?? i.created,
              attachments: inlineAttachments(i, context.client.config.baseUrl),
              links: linksFrom(i, context.client.config.baseUrl),
            })),
            announcements: anns
              .filter(
                (i) =>
                  dateMillis(
                    i.modifiedDate ?? i.modified ?? i.createdDate ?? i.created,
                  ) >= from,
              )
              .map((i) => ({
                ...tag,
                ...i,
                links: linksFrom(i, context.client.config.baseUrl),
              })),
            changedAssignments: changed
              .filter((i) => /asmt|assignment/.test(String(i.contentHandler)))
              .map((i) => ({ ...tag, contentId: i.id, title: i.title })),
            grades: cols
              .filter((c) => dateMillis(c.modifiedDate ?? c.modified) >= from)
              .flatMap((c) =>
                cells
                  .filter(
                    (g) =>
                      g.columnId === c.id &&
                      g.score !== undefined &&
                      g.score !== null,
                  )
                  .map((g) => ({
                    ...tag,
                    columnId: c.id,
                    title: c.name ?? c.title,
                    score: g.score,
                    pointsPossible: c.possible,
                    modifiedDate: c.modifiedDate ?? c.modified,
                  })),
              ),
          };
        },
      );
      if (selected.skipped)
        limitations.push(`${selected.skipped} older courses were not checked.`);
      limitations.push(
        "Dates describe new or changed items, not guaranteed original upload dates. Grades on unchanged older columns may be missed.",
      );
      const content = perCourse
        .flatMap((c) => c.content)
        .sort(
          (a, b) =>
            dateMillis(b.modifiedDate ?? b.createdDate) -
            dateMillis(a.modifiedDate ?? a.createdDate),
        );
      return json({
        since: new Date(from).toISOString(),
        courseCount: selected.items.length,
        content,
        announcements: perCourse.flatMap((c) => c.announcements),
        changedAssignments: perCourse.flatMap((c) => c.changedAssignments),
        grades: perCourse.flatMap((c) => c.grades),
        limitations,
      });
    }),
  );
}
