import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { readState } from './state.js';
import { BlackboardClient } from './bb/client.js';
import { registerCourseTools } from './tools/courses.js';
import { registerAssignmentTools } from './tools/assignments.js';
import { registerDiscussionTools } from './tools/discussions.js';
import { registerMessageTools } from './tools/messages.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerGroupTools } from './tools/groups.js';
import { registerProfileTools } from './tools/profile.js';
import { registerContentTools } from './tools/content.js';
import { registerAnnouncementTools } from './tools/announcements.js';
import { registerAssessmentTools } from './tools/assessments.js';
import { registerGradingTools } from './tools/grading.js';
import { registerEnrollmentTools } from './tools/enrollment.js';
import { registerRawTools } from './tools/raw.js';

export const VERSION = '0.1.0';

export interface ToolContext {
  client: BlackboardClient;
  allowWrites: boolean;
}

function fatal(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(1);
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const state = readState(config);

  if (!state) {
    fatal(
      'No Blackboard session found.\n' +
        'Run `uaeu-blackboard-mcp login` once, then start the server again.',
    );
  }

  const client = new BlackboardClient(config, state);
  const server = new McpServer({ name: 'uaeu-blackboard', version: VERSION });
  const context: ToolContext = { client, allowWrites: config.allowWrites };

  registerCourseTools(server, context);
  registerAssignmentTools(server, context);
  registerDiscussionTools(server, context);
  registerMessageTools(server, context);
  registerCalendarTools(server, context);
  registerGroupTools(server, context);
  registerProfileTools(server, context);
  registerContentTools(server, context);
  registerAnnouncementTools(server, context);
  registerAssessmentTools(server, context);
  registerGradingTools(server, context);
  registerEnrollmentTools(server, context);
  registerRawTools(server, context);

  const timer = setInterval(() => {
    void client.keepAlive();
  }, 4 * 60 * 1000);
  timer.unref();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startServer().catch((error: unknown) => {
  process.stderr.write(`Failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
