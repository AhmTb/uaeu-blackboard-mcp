import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi, htmlToText } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerMessageTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_list_conversations',
    {
      title: 'List conversations',
      description: 'List course message conversations with unread counts and participants.',
      inputSchema: { courseId: z.string(), limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, limit }) => {
      const resolved = await api.resolveCourse(courseId);
      const conversations = await api.conversations(resolved, limit ?? 50);
      return json({
        courseId: resolved,
        count: conversations.length,
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          createdDate: conversation.createdDate,
          updatedDate: conversation.updatedDate,
          unreadCount: conversation.unreadCount,
          messageCount: conversation.totalCount,
          canBeRepliedTo: conversation.canBeRepliedTo,
          participantIds: conversation.participantIds,
          participants: conversation.participants,
          lastMessage: conversation.messages?.[0]
            ? {
                id: conversation.messages[0].id,
                body: htmlToText(
                  conversation.messages[0].body?.rawText ?? conversation.messages[0].body?.displayText,
                ),
                senderId: conversation.messages[0].senderId,
                postDate: conversation.messages[0].postDate,
              }
            : undefined,
        })),
      });
    }),
  );

  server.registerTool(
    'bb_get_conversation',
    {
      title: 'Read conversation',
      description: 'Read every message in a conversation.',
      inputSchema: { courseId: z.string(), conversationId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, conversationId }) => {
      const resolved = await api.resolveCourse(courseId);
      const messages = await api.conversationMessages(resolved, conversationId);
      return json({
        courseId: resolved,
        conversationId,
        count: messages.length,
        messages: messages.map((message) => ({
          id: message.id,
          body: htmlToText(message.body?.rawText ?? message.body?.displayText),
          senderId: message.senderId,
          sender: message.sender,
          postDate: message.postDate,
          isRead: message.isRead,
        })),
      });
    }),
  );

  server.registerTool(
    'bb_message_summary',
    {
      title: 'Message unread summary',
      description:
        'Unread message counts for every course, without opening each course. Useful for "do I have messages?" questions.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async () => {
      const summary = await api.messageSummary();
      return json({
        courses: summary.map((course) => ({
          courseId: course.courseId,
          courseName: course.courseName,
          unread: course.numUnreadMessages,
          messagesEnabled: course.isCourseMessagesEnabled,
        })),
      });
    }),
  );

  server.registerTool(
    'bb_send_message',
    {
      title: 'Send course message',
      description:
        'Start a new conversation with one or more course participants. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        courseId: z.string(),
        participantIds: z.array(z.string()).min(1).describe('Blackboard user ids (e.g. _123_1)'),
        body: z.string(),
        canBeRepliedTo: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, participantIds, body, canBeRepliedTo, confirm }) => {
      assertWrites(context, confirm, 'send this message');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.sendMessage(resolved, participantIds, body, canBeRepliedTo ?? true);
      return json({ sent: true, result });
    }),
  );

  server.registerTool(
    'bb_reply_message',
    {
      title: 'Reply to conversation',
      description: 'Reply in an existing conversation. Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        courseId: z.string(),
        conversationId: z.string(),
        body: z.string(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    tool(async ({ courseId, conversationId, body, confirm }) => {
      assertWrites(context, confirm, 'reply to this conversation');
      const resolved = await api.resolveCourse(courseId);
      const result = await api.replyConversation(resolved, conversationId, body);
      return json({ sent: true, result });
    }),
  );

  server.registerTool(
    'bb_find_recipients',
    {
      title: 'Find message recipients',
      description:
        'Search the participants of a course so you can obtain the user ids needed by bb_send_message.',
      inputSchema: {
        courseId: z.string(),
        query: z.string().optional().describe('Match on given/family name or username'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async ({ courseId, query }) => {
      const resolved = await api.resolveCourse(courseId);
      const roster = await api.roster(resolved);
      const needle = query?.toLowerCase();
      const people = roster
        .filter((entry) => {
          if (!needle) return true;
          const user = entry.user ?? {};
          return [user.givenName, user.familyName, user.userName, user.displayName]
            .filter(Boolean)
            .some((value: string) => String(value).toLowerCase().includes(needle));
        })
        .slice(0, 50)
        .map((entry) => ({
          userId: entry.userId ?? entry.user?.id,
          name:
            entry.user?.displayName ??
            [entry.user?.givenName, entry.user?.familyName].filter(Boolean).join(' '),
          userName: entry.user?.userName,
          role: entry.role ?? entry.courseRoleId,
        }));
      return json({ courseId: resolved, count: people.length, people });
    }),
  );
}
