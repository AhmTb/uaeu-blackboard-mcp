import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi, assessmentFrom } from '../bb/api.js';
import { CourseReader } from '../bb/resources.js';
import { BlackboardError } from '../bb/client.js';
import { assertWrites, json, tool } from './util.js';

export function registerAssessmentTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_assessments',
    {
      title: 'List assessments',
      description:
        'List graded assessments (assignments, tests) in a course with type, due date, points, attempts and visibility.',
      inputSchema: { courseId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId }) => {
      const resolved = await api.resolveCourse(courseId);
      const columns = await api.gradeColumns(resolved);
      return json({
        courseId: resolved,
        count: columns.length,
        assessments: columns.map((column) => ({
          columnId: column.id,
          name: column.name ?? column.columnName,
          type: column.assessmentSubtype ?? column.scoreProviderHandle,
          dueDate: column.dueDate,
          pointsPossible: column.possible,
          attemptsAllowed: column.multipleAttempts,
          visible: column.visible,
          released: column.gradesReleased,
          contentId: column.contentId,
          rubricId: column.rubricId,
        })),
      });
    }),
  );

  server.registerTool(
    'bb_get_assessment',
    {
      title: 'Get assessment settings',
      description:
        'Get one assessment (gradebook column + linked content + questions when available).',
      inputSchema: { courseId: z.string(), columnId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, columnId }) => {
      const resolved = await api.resolveCourse(courseId);
      const column = await api.raw.get<Record<string, any>>(
        `/courses/${resolved}/gradebook/columns/${columnId}`,
      );
      let questions: unknown = undefined;
      let content: unknown;
      let instructions: string | undefined;
      let assessment: Record<string, any> = {};
      let attachments: unknown[] = [];
      const limitations: string[] = [];
      const contentId = column.contentId;
      if (contentId) {
        const detail = await api.assignment(resolved, contentId);
        content = detail.item;
        instructions = detail.summary?.instructions;
        assessment = assessmentFrom(detail.item);
        attachments = (await new CourseReader(context.client).attachments(resolved, contentId)).files;
        if (assessment.questionCount === 0) questions = [];
        else if (assessment.id) {
          try {
            questions = await api.raw.getAll(
              `/courses/${encodeURIComponent(resolved)}/assessments/${encodeURIComponent(assessment.id)}/questions`,
            );
          } catch (error) {
            if (!(error instanceof BlackboardError) || ![403, 404].includes(error.status)) throw error;
            limitations.push(`Questions unavailable (HTTP ${error.status}); no assessment attempt was started.`);
          }
        } else limitations.push('No assessment ID exposed by linked content.');
      }
      return json({ column, content, assessmentId: assessment.id, instructions, attachments, questions, limitations });
    }),
  );

  server.registerTool(
    'bb_create_assignment',
    {
      title: 'Create assignment',
      description:
        'Create a graded assignment (content + gradebook column) with instructions, due date, points and attempts. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor role.',
      inputSchema: {
        courseId: z.string(),
        title: z.string(),
        instructions: z.string().optional(),
        parentId: z.string().optional(),
        dueDate: z.string().optional().describe('ISO 8601'),
        pointsPossible: z.number().optional(),
        attemptsAllowed: z.number().int().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, confirm, ...input }) => {
      assertWrites(context, confirm, 'create this assignment');
      const resolved = await api.resolveCourse(courseId);
      return json({ created: true, assignment: await api.createAssignment(resolved, input) });
    }),
  );

  server.registerTool(
    'bb_set_assignment_deadline',
    {
      title: 'Change assignment deadline',
      description:
        'Update an assignment due date on its gradebook column. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor role.',
      inputSchema: {
        courseId: z.string(),
        columnId: z.string(),
        dueDate: z.string().describe('ISO 8601 timestamp'),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, columnId, dueDate, confirm }) => {
      assertWrites(context, confirm, 'change this deadline');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.raw.patch(`/courses/${resolved}/gradebook/columns/${columnId}`, { dueDate });
      return json({ updated: true, column: result });
    }),
  );

  server.registerTool(
    'bb_list_rubrics',
    {
      title: 'List rubrics',
      description: 'List rubrics available in a course.',
      inputSchema: { courseId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId }) => {
      const resolved = await api.resolveCourse(courseId);
      const rubrics = await api.rubrics(resolved);
      return json({ courseId: resolved, count: rubrics.length, rubrics });
    }),
  );

  server.registerTool(
    'bb_attach_rubric',
    {
      title: 'Attach rubric to assessment',
      description:
        'Associate a rubric with a gradebook column. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor role.',
      inputSchema: {
        courseId: z.string(),
        columnId: z.string(),
        rubricId: z.string(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, columnId, rubricId, confirm }) => {
      assertWrites(context, confirm, 'attach this rubric');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.raw.post(
        `/learn/api/public/v1/courses/${resolved}/rubrics/${rubricId}/associations`,
        {
          associationEntity: { gradebookColumnId: columnId },
          usedForGrading: true,
          rubricVisibility: 'VisibleWithScores',
        },
      );
      return json({ attached: true, result });
    }),
  );
}
