import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerContentTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_content',
    {
      title: 'List course content',
      description:
        'List one level of a course outline (modules, folders, pages, files, links, assignments). Use parentId ROOT for the main outline or INTERACTIVE for participation activities.',
      inputSchema: {
        courseId: z.string(),
        parentId: z.string().optional().describe('ROOT (default), INTERACTIVE, or a folder id'),
        limit: z.number().int().min(1).max(200).optional().describe('Page size, default 50'),
        offset: z.number().int().min(0).optional(),
        includeDescriptions: z.boolean().optional().describe('Include descriptions (default false)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, parentId, limit = 50, offset = 0, includeDescriptions }) => {
      const resolved = await api.resolveCourse(courseId);
      const page = await api.raw.get<Record<string, any>>(
        `/courses/${encodeURIComponent(resolved)}/contents/${encodeURIComponent(parentId ?? 'ROOT')}/children`,
        { query: { limit, offset }, cacheTtlMs: context.client.config.cacheTtlMs ?? 15_000 },
      );
      const results = Array.isArray(page?.results) ? page.results : [];
      return json({
        courseId: resolved,
        parentId: parentId ?? 'ROOT',
        count: results.length,
        nextPage: page?.paging?.nextPage ?? null,
        nextOffset: page?.paging?.nextPage ? offset + results.length : null,
        items: results.map((item: Record<string, any>) => ({
          id: item.id,
          title: item.title,
          handler: item.contentHandler,
          visibility: item.visibility,
          dueDate: item.genericReadOnlyData?.dueDate,
          description: includeDescriptions ? item.description : undefined,
          hasChildren: Boolean(item.contentDetail?.[item.contentHandler]?.isFolder),
          contentDetailUrl: item.contentDetailUrl,
        })),
        permissions: page?.permissions,
      });
    }),
  );

  server.registerTool(
    'bb_browse_course',
    {
      title: 'Browse full course outline',
      description:
        'Recursively flatten the entire course outline (modules, folders and items) with ids, handlers and visibility.',
      inputSchema: {
        courseId: z.string(),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum results, default 50'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, limit = 50, offset = 0 }) => {
      const resolved = await api.resolveCourse(courseId);
      const items = await api.walkContent(resolved);
      return json({
        courseId: resolved,
        count: items.slice(offset, offset + limit).length,
        total: items.length,
        nextOffset: offset + limit < items.length ? offset + limit : null,
        items: items.slice(offset, offset + limit).map((item) => ({
          id: item.id,
          parentId: item.parentId,
          title: item.title,
          handler: item.contentHandler,
          visibility: item.visibility,
          position: item.position,
        })),
      });
    }),
  );

  server.registerTool(
    'bb_get_content',
    {
      title: 'Get content item',
      description: 'Get one content item with its body text, attachments, due date and permissions.',
      inputSchema: { courseId: z.string(), contentId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, contentId }) => {
      const resolved = await api.resolveCourse(courseId);
      const item = await api.raw.get<Record<string, any>>(`/courses/${resolved}/contents/${contentId}`);
      return json(item);
    }),
  );

  server.registerTool(
    'bb_create_module',
    {
      title: 'Create module or folder',
      description:
        'Create a module/folder in the course outline. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor/designer role.',
      inputSchema: {
        courseId: z.string(),
        title: z.string(),
        parentId: z.string().optional().describe('ROOT (default) or a folder id'),
        kind: z.enum(['module', 'folder']).optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, title, parentId, kind, confirm }) => {
      assertWrites(context, confirm, 'create this module');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.createContent(resolved, {
        title,
        parentId: parentId ?? 'ROOT',
        handler: kind === 'folder' ? 'resource/x-bb-folder' : 'resource/x-bb-lesson',
      });
      return json({ created: true, item: result });
    }),
  );

  server.registerTool(
    'bb_create_page',
    {
      title: 'Create page',
      description:
        'Create a content page with HTML body inside a module/folder. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor/designer role.',
      inputSchema: {
        courseId: z.string(),
        title: z.string(),
        body: z.string().describe('HTML body'),
        parentId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, title, body, parentId, confirm }) => {
      assertWrites(context, confirm, 'create this page');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.createContent(resolved, {
        title,
        body,
        parentId: parentId ?? 'ROOT',
        handler: 'resource/x-bb-lesson',
      });
      return json({ created: true, item: result });
    }),
  );

  server.registerTool(
    'bb_update_content',
    {
      title: 'Update content item',
      description:
        'Update a content item title, body or visibility. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor/designer role.',
      inputSchema: {
        courseId: z.string(),
        contentId: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        visible: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, contentId, title, body, visible, confirm }) => {
      assertWrites(context, confirm, 'update this content item');
      const resolved = await api.resolveCourse(courseId);
      const patch: Record<string, unknown> = {};
      if (title !== undefined) patch.title = title;
      if (body !== undefined) patch.body = { rawText: body, displayText: '' };
      if (visible !== undefined) patch.visibility = visible ? 'VISIBLE' : 'HIDDEN';
      if (!Object.keys(patch).length) throw new Error('No changes supplied.');
      return json({ updated: true, item: await api.updateContent(resolved, contentId, patch) });
    }),
  );

  server.registerTool(
    'bb_set_content_visibility',
    {
      title: 'Show or hide content',
      description:
        'Change content visibility for students. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor/designer role.',
      inputSchema: {
        courseId: z.string(),
        contentId: z.string(),
        visible: z.boolean(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, contentId, visible, confirm }) => {
      assertWrites(context, confirm, 'change content visibility');
      const resolved = await api.resolveCourse(courseId);
      return json({
        updated: true,
        item: await api.updateContent(resolved, contentId, { visibility: visible ? 'VISIBLE' : 'HIDDEN' }),
      });
    }),
  );

  server.registerTool(
    'bb_delete_content',
    {
      title: 'Delete content item',
      description:
        'Delete a content item. Requires BB_ALLOW_WRITES=1, confirm:true and an instructor/designer role.',
      inputSchema: { courseId: z.string(), contentId: z.string(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    tool(async ({ courseId, contentId, confirm }) => {
      assertWrites(context, confirm, 'delete this content item');
      const resolved = await api.resolveCourse(courseId);
      await api.deleteContent(resolved, contentId);
      return json({ deleted: true, courseId: resolved, contentId });
    }),
  );
}
