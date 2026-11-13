import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi, htmlToText } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerAnnouncementTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_announcements',
    {
      title: 'List announcements',
      description: 'List course announcements, newest first, with bodies and read state.',
      inputSchema: { courseId: z.string(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, limit }) => {
      const resolved = await api.resolveCourse(courseId);
      const announcements = await api.announcements(resolved, limit ?? 50);
      return json({
        courseId: resolved,
        count: announcements.length,
        announcements: announcements.map((announcement) => ({
          id: announcement.id,
          title: announcement.title,
          body: htmlToText(announcement.body?.rawText ?? announcement.body?.displayText),
          createdDate: announcement.createdDate,
          modifiedDate: announcement.modifiedDate,
          isRead: announcement.readStatus?.isRead,
          permanent: announcement.permanent,
          availability: announcement.availability,
        })),
      });
    }),
  );

  server.registerTool(
    'bb_create_announcement',
    {
      title: 'Create announcement',
      description:
        'Create a course announcement, optionally scheduled with start/end dates. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor role.',
      inputSchema: {
        courseId: z.string(),
        title: z.string(),
        body: z.string().describe('HTML body'),
        startDate: z.string().optional().describe('ISO date to begin showing it'),
        endDate: z.string().optional().describe('ISO date to stop showing it'),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, title, body, startDate, endDate, confirm }) => {
      assertWrites(context, confirm, 'create this announcement');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.createAnnouncement(resolved, { title, body, startDate, endDate });
      return json({ created: true, announcement: result });
    }),
  );

  server.registerTool(
    'bb_update_announcement',
    {
      title: 'Update announcement',
      description:
        'Edit an announcement title or body. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor role.',
      inputSchema: {
        courseId: z.string(),
        announcementId: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, announcementId, title, body, confirm }) => {
      assertWrites(context, confirm, 'update this announcement');
      const resolved = await api.resolveCourse(courseId);
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (body !== undefined) patch.body = body;
      if (!Object.keys(patch).length) throw new Error('No changes supplied.');
      return json({ updated: true, announcement: await api.updateAnnouncement(resolved, announcementId, patch) });
    }),
  );

  server.registerTool(
    'bb_delete_announcement',
    {
      title: 'Delete announcement',
      description:
        'Delete an announcement. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor role.',
      inputSchema: {
        courseId: z.string(),
        announcementId: z.string(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    tool(async ({ courseId, announcementId, confirm }) => {
      assertWrites(context, confirm, 'delete this announcement');
      const resolved = await api.resolveCourse(courseId);
      await api.deleteAnnouncement(resolved, announcementId);
      return json({ deleted: true, courseId: resolved, announcementId });
    }),
  );
}
