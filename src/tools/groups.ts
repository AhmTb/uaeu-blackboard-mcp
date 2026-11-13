import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerGroupTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_groups',
    {
      title: 'List groups',
      description:
        'List the groups in a course, including your memberships, group sets, sign-up availability and member counts.',
      inputSchema: { courseId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId }) => {
      const resolved = await api.resolveCourse(courseId);
      const groups = await api.groups(resolved);
      return json({
        courseId: resolved,
        count: groups.length,
        groups: groups.map((group) => ({
          id: group.id,
          title: group.title,
          description: group.description?.displayText ?? group.description?.rawText ?? '',
          groupSetId: group.groupSetId,
          isAvailable: group.isAvailable,
          maximumEnrollment: group.maximumEnrollment,
          signUpSheet: group.signUpSheet,
          memberships: group.memberships,
          permissions: group.permissions,
          raw: group,
        })),
      });
    }),
  );

  server.registerTool(
    'bb_get_group',
    {
      title: 'Get group',
      description: 'Get one group with its members and shared resources.',
      inputSchema: { courseId: z.string(), groupId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, groupId }) => {
      const resolved = await api.resolveCourse(courseId);
      const [group, members] = await Promise.all([
        api.raw.get<Record<string, any>>(`/courses/${resolved}/groups/${groupId}`),
        api.groupMembers(resolved, groupId).catch(() => []),
      ]);
      return json({ group, members });
    }),
  );

  server.registerTool(
    'bb_list_group_members',
    {
      title: 'List group members',
      description: 'List members of one group.',
      inputSchema: { courseId: z.string(), groupId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, groupId }) => {
      const resolved = await api.resolveCourse(courseId);
      const members = await api.groupMembers(resolved, groupId);
      return json({ courseId: resolved, groupId, count: members.length, members });
    }),
  );

  server.registerTool(
    'bb_join_group',
    {
      title: 'Join a group',
      description:
        'Join a group that offers self sign-up. Requires BB_ALLOW_WRITES=1 and confirm:true. Experimental: Blackboard may restrict self-enrolment to the web UI.',
      inputSchema: { courseId: z.string(), groupId: z.string(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, groupId, confirm }) => {
      assertWrites(context, confirm, 'join this group');
      const resolved = await api.resolveCourse(courseId);
      const me = await api.me();
      const result = await api.raw.post(
        `/courses/${resolved}/groups/${groupId}/memberships`,
        { userId: me.id },
      );
      return json({ joined: true, result });
    }),
  );

  server.registerTool(
    'bb_upload_group_file',
    {
      title: 'Upload group file',
      description:
        'Upload a file to a group file area. Requires BB_ALLOW_WRITES=1 and confirm:true. Experimental: depends on the group tool being enabled.',
      inputSchema: {
        courseId: z.string(),
        groupId: z.string(),
        filePath: z.string().describe('Absolute local path'),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, groupId, filePath, confirm }) => {
      assertWrites(context, confirm, 'upload this group file');
      const resolved = await api.resolveCourse(courseId);
      const fs = await import('node:fs');
      const path = await import('node:path');
      const data = fs.readFileSync(filePath);
      const form = new FormData();
      form.append('file', new Blob([data]), path.basename(filePath));
      const result = await api.raw.request(
        `/courses/${resolved}/groups/${groupId}/contents`,
        { method: 'POST', form },
      );
      return json({ uploaded: true, result });
    }),
  );
}
