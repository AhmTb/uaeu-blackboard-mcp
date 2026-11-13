import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../index.js';
import { BlackboardError } from '../bb/client.js';

export function json(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data ?? null) }],
  };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wrap a handler so API failures become actionable tool errors instead of crashes. */
export function tool<T>(handler: (args: T) => Promise<CallToolResult>) {
  return async (args: T): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof BlackboardError) {
        const body =
          error.body === undefined ? '' : `\n${JSON.stringify(error.body).slice(0, 1000)}`;
        return fail(`${error.message}${body}`);
      }
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

export function assertWrites(context: ToolContext, confirm: boolean | undefined, action: string): void {
  if (!context.allowWrites) {
    throw new Error(
      `Write actions are disabled. Set BB_ALLOW_WRITES=1 in the MCP server environment to enable them.`,
    );
  }
  if (confirm !== true) {
    throw new Error(`Refusing to ${action} without confirmation. Pass confirm: true to proceed.`);
  }
}

export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ) as T;
}
