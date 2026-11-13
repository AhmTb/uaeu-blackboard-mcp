import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { json, tool } from './util.js';

interface Membership {
  courseId?: string;
  courseRoleId?: string;
  course?: Record<string, unknown>;
  [key: string]: unknown;
}

export function registerCourseTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'bb_whoami',
    {
      title: 'Who am I',
      description:
        'Return the signed-in Blackboard user, the API surface in use, and session health. Start here to confirm authentication.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async () => {
      const me = await context.client.get<Record<string, unknown>>('/users/me');
      return json({
        user: me,
        session: context.client.stats(),
      });
    }),
  );

  server.registerTool(
    'bb_list_courses',
    {
      title: 'List my courses',
      description:
        'List every course the signed-in user is enrolled in, with the internal course id (e.g. _12345_1), display name, course code and role. Course ids from here are required by the other tools.',
      inputSchema: {
        includeHidden: z
          .boolean()
          .optional()
          .describe('Include courses the user has hidden in the Blackboard UI. Default false.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ includeHidden }) => {
      const memberships =
        context.client.mode === 'internal'
          ? await context.client.getAll<Membership>('/users/me/memberships', {
              query: { expand: 'course' },
              cacheTtlMs: context.client.config.cacheTtlMs ?? 15_000,
            })
          : await context.client.getAll<Membership>('/users/me/courses', {
              query: { expand: 'course' },
              cacheTtlMs: context.client.config.cacheTtlMs ?? 15_000,
            });

      const courses = memberships
        .map((membership) => {
          const course = (membership.course ?? {}) as Record<string, unknown>;
          const availability = (course.availability ?? {}) as Record<string, unknown>;
          return {
            courseId: course.id ?? membership.courseId,
            name: course.name ?? course.displayName,
            courseCode: course.courseId ?? course.externalId,
            role: membership.role ?? membership.courseRoleId,
            ultra: course.ultraStatus,
            hidden:
              course.userHasHidden === true ||
              course.isAvailable === false ||
              availability.available === 'No',
            term: course.termId ?? undefined,
          };
        })
        .filter((course) => includeHidden || !course.hidden);

      return json({ count: courses.length, courses });
    }),
  );

  server.registerTool(
    'bb_get_course',
    {
      title: 'Get course',
      description:
        'Get one course by its internal id (e.g. _12345_1). Returns name, code, description, term, availability and enrolment settings.',
      inputSchema: {
        courseId: z.string().describe('Internal course id from bb_list_courses, e.g. _12345_1'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId }) => {
      const course = await context.client.get<Record<string, unknown>>(
        `/courses/${encodeURIComponent(courseId)}`,
      );
      return json(course);
    }),
  );

  server.registerTool(
    'bb_list_terms',
    {
      title: 'List terms',
      description: 'List academic terms configured on the Blackboard instance.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async () => {
      const terms = await context.client.getAll<Record<string, unknown>>('/terms', {
        query: { limit: context.client.config.pageSize },
      });
      return json({ count: terms.length, terms });
    }),
  );
}
