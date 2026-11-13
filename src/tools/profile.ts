import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { BlackboardApi } from '../bb/api.js';
import { assertWrites, json, tool } from './util.js';

export function registerProfileTools(server: McpServer, context: ToolContext): void {
  const api = new BlackboardApi(context.client);

  server.registerTool(
    'bb_get_profile',
    {
      title: 'Get my profile',
      description:
        'Return your profile: name, username, email, student id, avatar and which fields your account may edit.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async () => {
      const me = await api.me();
      return json({
        id: me.id,
        userName: me.userName,
        givenName: me.givenName,
        familyName: me.familyName,
        displayName: me.preferredDisplayName ?? [me.givenName, me.familyName].filter(Boolean).join(' '),
        email: me.emailAddress,
        studentId: me.studentId,
        systemRole: me.systemRole,
        avatar: me.avatar,
        editableFields: me.permissions?.fieldPermissions ?? {},
        raw: me,
      });
    }),
  );

  server.registerTool(
    'bb_update_profile',
    {
      title: 'Update my profile',
      description:
        'Update editable profile fields. Blackboard only permits fields flagged in editableFields (often just title). Requires BB_ALLOW_WRITES=1 and confirm:true.',
      inputSchema: {
        givenName: z.string().optional(),
        familyName: z.string().optional(),
        emailAddress: z.string().optional(),
        title: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(async ({ confirm, ...patch }) => {
      assertWrites(context, confirm, 'update your profile');
      const cleaned = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      if (!Object.keys(cleaned).length) throw new Error('No fields supplied.');
      const result = await api.updateProfile(cleaned);
      return json({ updated: true, profile: result });
    }),
  );

  server.registerTool(
    'bb_get_notification_prefs',
    {
      title: 'Get notification preferences',
      description:
        'Read your Ultra notification and email preferences. Experimental: the internal endpoint varies by Learn release.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    tool(async () => {
      const me = await api.me();
      const candidates = [
        `/users/${me.id}/notificationSettings`,
        `/users/${me.id}/preferences/notifications`,
        '/users/me/notificationSettings',
      ];
      const errors: string[] = [];
      for (const path of candidates) {
        try {
          return json(await api.raw.get(path));
        } catch (error) {
          errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`Notification preferences are not exposed on this instance.\n${errors.join('\n')}`);
    }),
  );
}
