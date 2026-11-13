import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi, htmlToText } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

function presentMessage(message: Record<string, any>) {
  return {
    id: message.id,
    subject: message.subject,
    body: htmlToText(message.body?.rawText ?? message.body?.displayText),
    author:
      message.postedName ??
      [message.givenName, message.familyName].filter(Boolean).join(' ') ??
      message.userId,
    createdDate: message.createdDate ?? message.postDate,
    editedDate: message.editDate,
    isRead: message.messageStatus?.isRead,
    replies: message.messageStatus?.numberOfChildren ?? 0,
    hasAttachment: message.messageStatus?.hasAttachment ?? false,
    lifecycle: message.lifecycle,
    raw: message,
  };
}

export function registerDiscussionTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_discussions',
    {
      title: 'List discussions',
      description:
        'List discussion forums in a course with ids, availability, posting rules and unread counts. Use the returned forumId with the other discussion tools.',
      inputSchema: { courseId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId }) => {
      const resolved = await api.resolveCourse(courseId);
      const forums = await api.forums(resolved);
      return json({ courseId: resolved, count: forums.length, forums });
    }),
  );

  server.registerTool(
    'bb_get_discussion',
    {
      title: 'Read discussion threads',
      description:
        'Read the threads (top-level posts) in a discussion forum, with authors, bodies and reply counts.',
      inputSchema: {
        courseId: z.string(),
        forumId: z.string(),
        boardId: z.string().optional().describe('Board id; defaults to "default"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, forumId, boardId }) => {
      const resolved = await api.resolveCourse(courseId);
      const messages = await api.forumMessages(resolved, boardId ?? 'default', forumId);
      return json({ courseId: resolved, forumId, count: messages.length, threads: messages.map(presentMessage) });
    }),
  );

  server.registerTool(
    'bb_get_discussion_thread',
    {
      title: 'Read discussion replies',
      description: 'Read every reply to one discussion thread.',
      inputSchema: {
        courseId: z.string(),
        forumId: z.string(),
        messageId: z.string(),
        boardId: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, forumId, messageId, boardId }) => {
      const resolved = await api.resolveCourse(courseId);
      const replies = await api.replies(resolved, boardId ?? 'default', forumId, messageId);
      return json({ courseId: resolved, messageId, count: replies.length, replies: replies.map(presentMessage) });
    }),
  );

  server.registerTool(
    'bb_create_discussion_thread',
    {
      title: 'Create discussion thread',
      description:
        'Start a new thread in a forum where students may create threads. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        courseId: z.string(),
        forumId: z.string(),
        subject: z.string(),
        body: z.string().describe('Thread body (plain text or HTML)'),
        boardId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, forumId, subject, body, boardId, confirm }) => {
      assertWrites(context, confirm, 'create this discussion thread');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.createThread(resolved, forumId, subject, body, boardId);
      return json({ created: true, result });
    }),
  );

  server.registerTool(
    'bb_reply_to_discussion',
    {
      title: 'Reply to discussion thread',
      description:
        'Reply to an existing discussion post. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        courseId: z.string(),
        forumId: z.string(),
        messageId: z.string(),
        body: z.string(),
        boardId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, forumId, messageId, body, boardId, confirm }) => {
      assertWrites(context, confirm, 'reply to this discussion');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.replyToMessage(resolved, forumId, messageId, body, boardId);
      return json({ replied: true, result });
    }),
  );

  server.registerTool(
    'bb_edit_discussion_post',
    {
      title: 'Edit own discussion post',
      description:
        'Edit a post you authored, where the forum allows edits. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        courseId: z.string(),
        forumId: z.string(),
        messageId: z.string(),
        body: z.string(),
        boardId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ courseId, forumId, messageId, body, boardId, confirm }) => {
      assertWrites(context, confirm, 'edit this discussion post');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.editMessage(resolved, forumId, messageId, body, boardId);
      return json({ edited: true, result });
    }),
  );

  server.registerTool(
    'bb_delete_discussion_post',
    {
      title: 'Delete own discussion post',
      description:
        'Delete a post you authored, where the forum allows deletion. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        courseId: z.string(),
        forumId: z.string(),
        messageId: z.string(),
        boardId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    tool(async ({ courseId, forumId, messageId, boardId, confirm }) => {
      assertWrites(context, confirm, 'delete this discussion post');
      const resolved = await api.resolveCourse(courseId);
      await api.deleteMessage(resolved, forumId, messageId, boardId);
      return json({ deleted: true, courseId: resolved, messageId });
    }),
  );
}
