import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerCalendarTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_calendar',
    {
      title: 'List calendar',
      description:
        'List calendar items and deadlines in a date range (ISO 8601). Includes graded activity due dates and your personal events.',
      inputSchema: {
        since: z.string().optional().describe('ISO start, e.g. 2026-11-01T00:00:00Z'),
        until: z.string().optional().describe('ISO end, e.g. 2026-12-01T00:00:00Z'),
        courseId: z.string().optional().describe('Filter to one course'),
        onlyPersonal: z.boolean().optional().describe('Only events you created'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ since, until, courseId, onlyPersonal }) => {
      const items = await api.calendar(since, until);
      const resolved = courseId ? await api.resolveCourse(courseId) : undefined;
      const filtered = items.filter((item) => {
        if (onlyPersonal && !item.userCreated) return false;
        if (resolved && item.courseId !== resolved) return false;
        return true;
      });
      return json({ count: filtered.length, items: filtered });
    }),
  );

  server.registerTool(
    'bb_create_calendar_event',
    {
      title: 'Create personal calendar event',
      description:
        'Create an event on your personal Blackboard calendar. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        title: z.string(),
        startDate: z.string().describe('ISO 8601 timestamp'),
        endDate: z.string().describe('ISO 8601 timestamp'),
        description: z.string().optional(),
        location: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ title, startDate, endDate, description, location, confirm }) => {
      assertWrites(context, confirm, 'create this calendar event');
      const result = await api.createEvent({ title, startDate, endDate, description, location });
      return json({ created: true, event: result });
    }),
  );

  server.registerTool(
    'bb_update_calendar_event',
    {
      title: 'Update personal calendar event',
      description:
        'Update an event you created (personal calendar only). Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        itemId: z.string().describe('item id from bb_list_calendar where userCreated=true'),
        title: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ itemId, confirm, ...patch }) => {
      assertWrites(context, confirm, 'update this calendar event');
      const result = await api.updateEvent(itemId, patch);
      return json({ updated: true, event: result });
    }),
  );

  server.registerTool(
    'bb_delete_calendar_event',
    {
      title: 'Delete personal calendar event',
      description:
        'Delete an event you created. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: { itemId: z.string(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    tool(async ({ itemId, confirm }) => {
      assertWrites(context, confirm, 'delete this calendar event');
      await api.deleteEvent(itemId);
      return json({ deleted: true, itemId });
    }),
  );
}
