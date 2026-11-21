#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { readState } from './state.js';
import { connectLinkedService, loginInteractive, loginWithCookieHeader } from './auth/login.js';
import { pickApiMode, probeSurfaces } from './bb/probe.js';
import { loginSettings, forgetLogin } from './auth/credentials.js';
import { updateLoginPreferences } from './auth/preferences.js';

function usage(): void {
  process.stdout.write(
    [
      'uaeu-blackboard-mcp — MCP server for UAEU Blackboard',
      '',
      'Usage:',
      '  uaeu-blackboard-mcp                 Start the MCP server (stdio)',
      '  uaeu-blackboard-mcp login           Open a browser and sign in (SSO + MFA)',
      '  uaeu-blackboard-mcp login --cookie "<Cookie header>"',
      '  uaeu-blackboard-mcp login --remember  Sign in once and remember the login securely',
      '  uaeu-blackboard-mcp auto-login on|off|status|forget',
      '  uaeu-blackboard-mcp status          Show the stored session',
      '  uaeu-blackboard-mcp probe           Test both API surfaces',
      '  uaeu-blackboard-mcp doctor          Diagnose configuration',
      '  uaeu-blackboard-mcp connect google  Sign in to linked Google files in a separate browser',
      '  uaeu-blackboard-mcp connect zoom    Sign in to linked Zoom recordings',
      '',
      'Environment:',
      '  BB_URL, BB_ALLOW_WRITES=1, BB_STATE_DIR, BB_PAGE_SIZE, BB_AUTO_LOGIN',
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
  if (args.includes('--remember')) {
    if (cookie) throw new Error('--remember needs a browser sign-in so the submitted login can be saved. Omit --cookie and BB_COOKIE.');
    if (config.autoLogin === false) throw new Error('BB_AUTO_LOGIN disables automatic sign-in. Remove it or set it to 1 before using --remember.');
    updateLoginPreferences(config, { autoLogin: true, rememberLogin: true });
  }
  const state = cookie
    ? await loginWithCookieHeader(config, cookie)
    : await loginInteractive(config);
  if (args.includes('--remember')) {
    const settings = await loginSettings(config);
    process.stdout.write(`Remembered login: ${settings.savedLogin === true ? 'saved in OS credential store' : 'not saved; enter your password during a full browser sign-in on a supported login origin'}\n`);
  }

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
  process.stdout.write(`Login settings: ${JSON.stringify(await loginSettings(config))}\n`);
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

async function cmdAutoLogin(args: string[]): Promise<void> {
  const config = loadConfig();
  const action = args[0] ?? 'status';
  if (args.length > 1 || !['on', 'off', 'status', 'forget'].includes(action)) {
    throw new Error('Use auto-login on, off, status, or forget.');
  }
  if (action === 'on') updateLoginPreferences(config, { autoLogin: true, rememberLogin: true });
  if (action === 'off') updateLoginPreferences(config, { autoLogin: false });
  if (action === 'forget') await forgetLogin(config);
  process.stdout.write(JSON.stringify(await loginSettings(config), null, 2) + '\n');
  if (action === 'on') process.stdout.write('Your next successful browser sign-in will remember submitted credentials. Run login --remember to do it now.\n');
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
  checks.push(`Auto login:  ${JSON.stringify(await loginSettings(config))}`);

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
    case 'auto-login':
      await cmdAutoLogin(args);
      return;
    case 'connect':
      if(!args[0])throw new Error('Use connect google, connect zoom, or connect <Google/Zoom HTTPS URL>.');
      await connectLinkedService(loadConfig(),args[0]);
      return;
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
