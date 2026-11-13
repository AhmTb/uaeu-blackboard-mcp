import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerEnrollmentTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_roster',
    {
      title: 'List course members',
      description:
        'List enrollments and roles for a course. Instructors and authorized staff see the full roster; students see what Blackboard exposes.',
      inputSchema: {
        courseId: z.string(),
        role: z.string().optional().describe('Filter by role, e.g. S, T, P, I'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, role }) => {
      const resolved = await api.resolveCourse(courseId);
      const roster = await api.roster(resolved);
      const members = roster
        .filter((entry) => !role || String(entry.role ?? entry.courseRoleId) === role)
        .map((entry) => ({
          membershipId: entry.id,
          userId: entry.userId ?? entry.user?.id,
          name:
            entry.user?.displayName ??
            [entry.user?.givenName, entry.user?.familyName].filter(Boolean).join(' '),
          userName: entry.user?.userName,
          role: entry.role ?? entry.courseRoleId,
          available: entry.available,
          permissions: entry.permissions,
        }));
      return json({ courseId: resolved, count: members.length, members });
    }),
  );

  server.registerTool(
    'bb_add_member',
    {
      title: 'Enroll a member',
      description:
        'Enroll a user in a course with a role. Requires BB_ALLOW_WRITES=1, confirm:true and course management permission.',
      inputSchema: {
        courseId: z.string(),
        userId: z.string(),
        role: z.enum(['S', 'T', 'P', 'I', 'G']).describe('S=student, T=instructor, P=teaching assistant, I=instructor, G=grader'),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, userId, role, confirm }) => {
      assertWrites(context, confirm, 'enroll this member');
      const resolved = await api.resolveCourse(courseId);
      return json({ added: true, membership: await api.addMember(resolved, userId, role) });
    }),
  );

  server.registerTool(
    'bb_update_member_role',
    {
      title: 'Change member role',
      description:
        'Change a member\'s course role. Requires BB_ALLOW_WRITES=1, confirm:true and course management permission.',
      inputSchema: {
        courseId: z.string(),
        userId: z.string().describe('User id from bb_list_roster'),
        role: z.enum(['S', 'T', 'P', 'I', 'G']),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, userId, role, confirm }) => {
      assertWrites(context, confirm, 'change this member role');
      const resolved = await api.resolveCourse(courseId);
      return json({
        updated: true,
        membership: await api.updateMember(resolved, userId, { courseRoleId: role }),
      });
    }),
  );

  server.registerTool(
    'bb_remove_member',
    {
      title: 'Remove a member',
      description:
        'Remove an enrollment from a course. Requires BB_ALLOW_WRITES=1, confirm:true and course management permission.',
      inputSchema: { courseId: z.string(), userId: z.string(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    tool(async ({ courseId, userId, confirm }) => {
      assertWrites(context, confirm, 'remove this member');
      const resolved = await api.resolveCourse(courseId);
      await api.removeMember(resolved, userId);
      return json({ removed: true, courseId: resolved, userId });
    }),
  );
}
