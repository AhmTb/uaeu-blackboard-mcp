#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { readState } from './state.js';
import { loginInteractive, loginWithCookieHeader } from './auth/login.js';
import { pickApiMode, probeSurfaces } from './bb/probe.js';

function usage(): void {
  process.stdout.write(
    [
      'uaeu-blackboard-mcp — MCP server for UAEU Blackboard',
      '',
      'Usage:',
      '  uaeu-blackboard-mcp                 Start the MCP server (stdio)',
      '  uaeu-blackboard-mcp login           Open a browser and sign in (SSO + MFA)',
      '  uaeu-blackboard-mcp login --cookie "<Cookie header>"',
      '  uaeu-blackboard-mcp status          Show the stored session',
      '  uaeu-blackboard-mcp probe           Test both API surfaces',
      '  uaeu-blackboard-mcp doctor          Diagnose configuration',
      '',
      'Environment:',
      '  BB_URL, BB_ALLOW_WRITES=1, BB_STATE_DIR, BB_PAGE_SIZE',
      '',
    ].join('\n'),
  );
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function cmdLogin(args: string[]): Promise<void> {
  const config = loadConfig();
  const cookie = argValue(args, '--cookie') ?? process.env.BB_COOKIE;
  const state = cookie
    ? await loginWithCookieHeader(config, cookie)
    : await loginInteractive(config);

  process.stdout.write(
    [
      '',
      `Signed in as: ${state.user?.displayName ?? state.user?.userName ?? 'unknown'}`,
      `Email:        ${state.user?.email ?? 'unknown'}`,
      `Instance:     ${state.baseUrl}`,
      `API mode:     ${state.apiMode ?? 'unknown'}`,
      `Session file: ${config.sessionFile}`,
      '',
    ].join('\n'),
  );
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const state = readState(config);
  if (!state) {
    process.stdout.write(`No stored session. Run: uaeu-blackboard-mcp login\n`);
    return;
  }

  const probe = await probeSurfaces(config, state);
  const mode = pickApiMode(probe);
  process.stdout.write(
    [
      `Instance:   ${state.baseUrl}`,
      `Signed in:  ${state.user?.displayName ?? 'unknown'} <${state.user?.email ?? 'unknown'}>`,
      `Stored API: ${state.apiMode ?? 'unknown'}`,
      `Live API:   ${mode ?? 'none (session expired)'}`,
      `Cookies:    ${state.cookies.length} (updated ${state.updatedAt})`,
      `Internal:   HTTP ${probe.internal.status}`,
      `Public:     HTTP ${probe.publicApi.status}`,
      '',
    ].join('\n'),
  );
}

async function cmdProbe(): Promise<void> {
  const config = loadConfig();
  const state = readState(config);
  if (!state) {
    process.stdout.write('No stored session. Run: uaeu-blackboard-mcp login\n');
    return;
  }
  const probe = await probeSurfaces(config, state);
  process.stdout.write(JSON.stringify(probe, null, 2) + '\n');
}

async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  const state = readState(config);
  const checks: string[] = [];
  checks.push(`Node:        ${process.version}`);
  checks.push(`Instance:    ${config.baseUrl}`);
  checks.push(`State dir:   ${config.stateDir}`);
  checks.push(`Session:     ${state ? 'present' : 'missing'}${state ? ` (${state.cookies.length} cookies)` : ''}`);
  checks.push(`Writes:      ${config.allowWrites ? 'enabled' : 'disabled (set BB_ALLOW_WRITES=1)'}`);

  const edgePaths = [
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['ProgramFiles'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  checks.push(`Edge:        ${edgePaths.some((p) => p && fs.existsSync(p)) ? 'installed' : 'not found'}`);

  if (state) {
    const probe = await probeSurfaces(config, state);
    checks.push(`Internal:    HTTP ${probe.internal.status} (${probe.internal.ok ? 'usable' : 'blocked'})`);
    checks.push(`Public:      HTTP ${probe.publicApi.status} (${probe.publicApi.ok ? 'usable' : 'blocked'})`);
  } else {
    checks.push('Internal:    n/a (not signed in)');
    checks.push('Public:      n/a (not signed in)');
  }

  process.stdout.write(checks.join('\n') + '\n');
}

async function main(): Promise<void> {
  const [command = 'serve', ...args] = process.argv.slice(2);

  switch (command) {
    case 'login':
      await cmdLogin(args);
      return;
    case 'status':
      await cmdStatus();
      return;
    case 'probe':
      await cmdProbe();
      return;
    case 'doctor':
      await cmdDoctor();
      return;
    case 'serve':
      await import('./index.js');
      return;
    case '--help':
    case '-h':
    case 'help':
      usage();
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
