import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { forgetLogin, loginSettings } from '../auth/credentials.js';
import { updateLoginPreferences } from '../auth/preferences.js';
import { json, tool } from './util.js';

export function registerAuthTools(server: McpServer, context: ToolContext): void {
  const config = context.client.config;
  server.registerTool('bb_get_login_settings', {
    title: 'Get automatic sign-in settings',
    description: 'Read local automatic sign-in settings and whether a login is remembered. Never returns usernames, passwords, or cookies. Does not sign in.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, tool(async () => json(await loginSettings(config))));

  server.registerTool('bb_set_auto_login', {
    title: 'Enable or disable automatic sign-in',
    description: 'Change local automatic sign-in settings without signing in. Enabling opts into securely remembering credentials submitted during the next successful browser login. Disabling stops automatic recovery and password capture/use; forget:true also deletes the saved password. An explicit BB_AUTO_LOGIN environment setting overrides the on/off preference. Existing API sessions remain usable.',
    inputSchema: { enabled: z.boolean(), forget: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, tool(async ({ enabled, forget }) => {
    if (enabled && forget) throw new Error('Use enabled:false with forget:true.');
    if (forget) await forgetLogin(config);
    else updateLoginPreferences(config, enabled ? { autoLogin: true, rememberLogin: true } : { autoLogin: false });
    return json(await loginSettings(config));
  }));
}
