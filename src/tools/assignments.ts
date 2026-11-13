import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi, htmlToText } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerAssignmentTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_assignments',
    {
      title: 'List assignments',
      description:
        'List assignments and graded activities in a course with due dates, points, allowed attempts, and whether the student has submitted. Accepts a course id, course code (e.g. COURSE101_12345_Fall_2026) or unique name fragment.',
      inputSchema: {
        courseId: z.string().describe('Course id, course code, or unique name fragment'),
        includeSubmitted: z.boolean().optional().describe('Include already-submitted items (default true)'),
        includeInstructions: z.boolean().optional().describe('Include instruction text (default false; use bb_get_assignment for details)'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum results, default 50'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, includeSubmitted, includeInstructions, limit = 50, offset = 0 }) => {
      const resolved = await api.resolveCourse(courseId);
      const assignments = await api.assignments(resolved);
      const filtered =
        includeSubmitted === false
          ? assignments.filter((item) => item.submissionStatus !== 'submitted')
          : assignments;
      const page = filtered.slice(offset, offset + limit).map(({ instructions, ...item }) =>
        includeInstructions ? { ...item, instructions } : item);
      return json({ courseId: resolved, count: page.length, total: filtered.length,
        nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
        assignments: page });
    }),
  );

  server.registerTool(
    'bb_get_assignment',
    {
      title: 'Get assignment details',
      description:
        'Get one assignment: instructions, rubric hint, deadline, points, attempts allowed, submission status, your score, and any attached files.',
      inputSchema: {
        courseId: z.string(),
        contentId: z.string().describe('Assignment content id from bb_list_assignments'),
        includeRaw: z.boolean().optional().describe('Include full Blackboard response (default false)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, contentId, includeRaw }) => {
      const resolved = await api.resolveCourse(courseId);
      const { item, summary } = await api.assignment(resolved, contentId);
      const detail = item.contentDetail?.['resource/x-bb-asmt-test-link']?.test ?? {};
      return json({
        courseId: resolved,
        contentId,
        title: item.title,
        instructions: summary?.instructions ?? htmlToText(item.description),
        dueDate: summary?.dueDate,
        pointsPossible: summary?.pointsPossible,
        attemptsAllowed: summary?.attemptsAllowed,
        columnId: summary?.columnId,
        submissionStatus: summary?.submissionStatus,
        score: summary?.score,
        settings: {
          allowFileSubmission: detail.deploymentSettings?.allowFileSubmission,
          allowTextSubmission: detail.deploymentSettings?.allowTextSubmission,
          attemptCount: detail.deploymentSettings?.attemptCount,
        },
        attachments: item.attachments ?? [],
        raw: includeRaw ? item : undefined,
      });
    }),
  );

  server.registerTool(
    'bb_get_assignment_submission',
    {
      title: 'Get assignment submissions',
      description:
        'List attempts and submission files on a gradebook column. Students see their own attempts; instructors see every attempt.',
      inputSchema: {
        courseId: z.string(),
        columnId: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, columnId }) => {
      const resolved = await api.resolveCourse(courseId);
      const attempts = await api.columnAttempts(resolved, columnId);
      return json(attempts);
    }),
  );

  server.registerTool(
    'bb_submit_assignment',
    {
      title: 'Submit assignment',
      description:
        'Submit work to an assignment: creates an attempt, uploads files, and posts it for grading. Requires BB_ALLOW_WRITES=1 and confirm:true. Experimental: verify the attempt in Blackboard after the first use.',
      inputSchema: {
        courseId: z.string(),
        contentId: z.string().describe('Assignment content id from bb_list_assignments'),
        text: z.string().optional().describe('Text submission body (plain text or HTML)'),
        filePaths: z.array(z.string()).optional().describe('Absolute local file paths to upload'),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    tool(async ({ courseId, contentId, text, filePaths, confirm }) => {
      assertWrites(context, confirm, 'submit this assignment');
      const resolved = await api.resolveCourse(courseId);
      const { summary: assignment } = await api.assignment(resolved, contentId);
      if (!assignment?.columnId) {
        throw new Error(`No gradebook column found for assignment ${contentId}.`);
      }
      if (!text && (!filePaths || filePaths.length === 0)) {
        throw new Error('Provide text, filePaths, or both.');
      }
      const result = await api.submitAssignment(resolved, assignment.columnId, { text, filePaths });
      return json({
        submitted: true,
        courseId: resolved,
        columnId: assignment.columnId,
        assignment: assignment.title,
        result,
      });
    }),
  );
}
