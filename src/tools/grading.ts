import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi, optionalRead } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerGradingTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_get_gradebook',
    {
      title: 'Get gradebook',
      description:
        'Return gradebook columns plus your own grades for a course. Instructors also see every column and its scoring settings.',
      inputSchema: { courseId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId }) => {
      const resolved = await api.resolveCourse(courseId);
      const [columns, grades] = await Promise.all([
        api.gradeColumns(resolved),
        optionalRead(api.myGrades(resolved), []),
      ]);
      const byColumn = new Map(grades.map((grade) => [String(grade.columnId), grade]));
      return json({
        courseId: resolved,
        columns: columns.map((column) => {
          const grade = byColumn.get(String(column.id));
          return {
            columnId: column.id,
            name: column.name ?? column.columnName,
            dueDate: column.dueDate,
            pointsPossible: column.possible,
            visible: column.visible,
            myScore: grade?.score,
            myStatus: grade?.manualStatus,
            exempt: grade?.isExempt,
            lastAttemptId: grade?.lastAttemptId,
          };
        }),
      });
    }),
  );

  server.registerTool(
    'bb_get_my_grades',
    {
      title: 'Get my grades',
      description: 'Return your grades for one course, with points possible and submission state.',
      inputSchema: { courseId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId }) => {
      const resolved = await api.resolveCourse(courseId);
      const grades = await api.myGrades(resolved);
      return json({ courseId: resolved, count: grades.length, grades });
    }),
  );

  server.registerTool(
    'bb_list_column_attempts',
    {
      title: 'List gradebook attempts',
      description:
        'List attempts on a gradebook column. Students see their own; instructors see all students.',
      inputSchema: { courseId: z.string(), columnId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, columnId }) => {
      const resolved = await api.resolveCourse(courseId);
      return json(await api.columnAttempts(resolved, columnId));
    }),
  );

  server.registerTool(
    'bb_get_attempt',
    {
      title: 'Get attempt detail',
      description: 'Get one submission attempt, including files, receipt and submission text.',
      inputSchema: { courseId: z.string(), attemptId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, attemptId }) => {
      const resolved = await api.resolveCourse(courseId);
      return json(await api.attempt(resolved, attemptId));
    }),
  );

  server.registerTool(
    'bb_grade_submission',
    {
      title: 'Grade a submission',
      description:
        'Enter or change a grade and feedback for one student on a column. Requires BB_ALLOW_WRITES=1, confirm:true and a grading role.',
      inputSchema: {
        courseId: z.string(),
        columnId: z.string(),
        userId: z.string(),
        score: z.number().optional(),
        feedback: z.string().optional(),
        exempt: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, columnId, userId, score, feedback, exempt, confirm }) => {
      assertWrites(context, confirm, 'grade this submission');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.setGrade(resolved, columnId, userId, { score, feedback, exempt });
      return json({ graded: true, result });
    }),
  );

  server.registerTool(
    'bb_set_grade_exception',
    {
      title: 'Grant extension or exemption',
      description:
        'Set a per-student exception (deadline extension or exemption) on a column. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor role.',
      inputSchema: {
        courseId: z.string(),
        columnId: z.string(),
        userId: z.string(),
        dueDate: z.string().optional().describe('New due date (ISO 8601)'),
        exempt: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, columnId, userId, dueDate, exempt, confirm }) => {
      assertWrites(context, confirm, 'set this grade exception');
      const resolved = await api.resolveCourse(courseId);
      const path = `/learn/api/public/v1/courses/${resolved}/gradebook/columns/${columnId}/exceptions/users/${userId}`;
      const result = await api.raw.put(path, {
        ...(dueDate ? { dueDate } : {}),
        ...(exempt !== undefined ? { exempt } : {}),
      });
      return json({ updated: true, exception: result });
    }),
  );
}
