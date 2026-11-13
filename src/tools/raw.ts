import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../index.js';
import { assertWrites, json, tool } from './util.js';

function validatePath(path: string): string {
  if (!path.startsWith('/')) throw new Error('path must start with "/"');
  if (path.includes('..')) throw new Error('path must not contain ".."');
  if (!path.startsWith('/learn/api/')) {
    throw new Error('path must target /learn/api/... on the configured Blackboard instance');
  }
  return path;
}

export function registerRawTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'bb_raw_request',
    {
      title: 'Raw Blackboard API request',
      description:
        'Escape hatch: call any Blackboard API path on the configured instance, for operations not covered by a dedicated tool. GET is always allowed; POST/PUT/PATCH/DELETE require BB_ALLOW_WRITES=1 and confirm:true. Returns the parsed JSON response.',
      inputSchema: {
        path: z
          .string()
          .describe('Absolute API path, e.g. /learn/api/v1/courses/_123_1/contents/ROOT/children'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional().describe('JSON request body for write methods'),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    tool(async ({ path, method = 'GET', query, body, confirm }) => {
      const safePath = validatePath(path);
      if (method === 'GET') {
        const data = await context.client.get<unknown>(safePath, { query });
        return json(data);
      }
      assertWrites(context, confirm, `${method} ${safePath}`);
      const data = await context.client.request<unknown>(safePath, { method, query, body });
      return json(data);
    }),
  );
}
