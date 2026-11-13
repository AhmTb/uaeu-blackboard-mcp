import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resourceUrl } from '../bb/resources.js';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { Config } from '../config.js';
import {
  emptyState,
  writeState,
  type SessionState,
  type SessionUser,
  type StoredCookie,
} from '../state.js';
import { pickApiMode, probeSurfaces } from '../bb/probe.js';

const SESSION_COOKIE = 'BbRouter';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function log(message: string): void {
  process.stdout.write(message + '\n');
}

function profileDir(config: Config): string {
  return path.join(config.stateDir, 'browser-profile');
}

function toStoredCookies(cookies: Awaited<ReturnType<BrowserContext['cookies']>>): StoredCookie[] {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }));
}

async function launchBrowser(config: Config): Promise<BrowserContext> {
  fs.mkdirSync(profileDir(config), { recursive: true });
  const channels = ['msedge', 'chrome'] as const;
  let lastError: unknown;

  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(profileDir(config), {
        channel,
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: ['--no-first-run', '--no-default-browser-check'],
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    'Could not launch Microsoft Edge or Google Chrome. Install one of them, or sign in with ' +
      '`uaeu-blackboard-mcp login --cookie "<Cookie header>"`.\n' +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

/** Separate, opt-in login for linked course services; never opens the user's Chrome profile. */
export async function connectLinkedService(config: Config, value: string): Promise<void> {
  const url=resourceUrl(value==='google'?'https://accounts.google.com/':value==='zoom'?'https://zoom.us/signin':value);
  if (!/(^|\.)(google\.com|zoom\.us)$/.test(url.hostname)) throw new Error('connect supports Google and Zoom. Use google, zoom, or an HTTPS URL on these services.');
  if (!process.stdin.isTTY) throw new Error('Run connect in an interactive terminal to complete sign-in yourself.');
  const context=await launchBrowser({...config,stateDir:path.join(config.stateDir,'linked')});
  const input=createInterface({input:process.stdin,output:process.stdout});
  try {
    const page=context.pages()[0]??await context.newPage();
    await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:60000});
    await input.question('Sign in in the separate browser window, then press Enter here to save this linked-site session: ',{signal:AbortSignal.timeout(LOGIN_TIMEOUT_MS)});
    const state=emptyState(url.origin);
    state.cookies=toStoredCookies((await context.cookies()).filter(c=>!/(^|\.)blackboard\.com$/.test(c.domain.replace(/^\./,''))));
    writeState({...config,sessionFile:path.join(config.stateDir,'linked-session.json')},state);
    log('Linked-site session saved locally. Retry bb_read_link.');
  } finally {input.close();await context.close().catch(()=>undefined);}
}

async function exportUser(config: Config, state: SessionState): Promise<SessionUser | undefined> {
  const probe = await probeSurfaces(config, state);
  const mode = pickApiMode(probe);
  if (!mode) return undefined;

  state.apiMode = mode;
  const payload = mode === 'internal' ? probe.internal.body : probe.publicApi.body;
  const user = payload as Record<string, unknown> | undefined;
  if (!user || typeof user !== 'object') return undefined;

  const id = String(user.id ?? user.userId ?? '');
  if (!id) return undefined;
  const name = (user.name ?? {}) as { given?: string; family?: string };
  return {
    id,
    userName: typeof user.userName === 'string' ? user.userName : undefined,
    displayName:
      typeof user.displayName === 'string'
        ? user.displayName
        : [name.given, name.family].filter(Boolean).join(' ') || undefined,
    email: typeof user.email === 'string' ? user.email : undefined,
  };
}

/** Interactive SSO login: opens a real browser, waits for the session, then stores cookies. */
export async function loginInteractive(config: Config): Promise<SessionState> {
  const context = await launchBrowser(config);
  const page: Page = context.pages()[0] ?? (await context.newPage());

  try {
    log('');
    log('  A browser window is open. Sign in to UAEU Blackboard (SSO + MFA).');
    log('  This window stays open until the session is captured. Up to 10 minutes.');
    log('');

    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let state: SessionState | undefined;
    let lastNote = 0;

    while (Date.now() < deadline) {
      if (!context.browser()?.isConnected() && context.pages().length === 0) {
        throw new Error('The browser was closed before a session was captured.');
      }

      const cookies = await context.cookies();
      const hasSession = cookies.some((cookie) => cookie.name === SESSION_COOKIE && cookie.value);

      if (hasSession) {
        const candidate = emptyState(config.baseUrl);
        candidate.cookies = toStoredCookies(
          cookies.filter((cookie) => cookie.domain.includes('blackboard.com')),
        );
        const probe = await probeSurfaces(config, candidate);
        const mode = pickApiMode(probe);

        if (mode) {
          candidate.apiMode = mode;
          candidate.user = await exportUser(config, candidate);
          candidate.lastVerifiedAt = new Date().toISOString();
          candidate.updatedAt = candidate.lastVerifiedAt;
          state = candidate;
          break;
        }
      }

      if (Date.now() - lastNote > 15_000) {
        lastNote = Date.now();
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        log(`  Waiting for sign-in… (${remaining}s remaining)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }

    if (!state) {
      throw new Error('Timed out waiting for a Blackboard session.');
    }

    writeState(config, state);

    log('');
    log(`  Signed in as ${state.user?.displayName ?? state.user?.userName ?? 'unknown user'}`);
    log(`  Instance:  ${state.baseUrl}`);
    log(`  API mode:  ${state.apiMode}`);
    log(`  Session:   ${config.sessionFile}`);
    log('');
    return state;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Non-interactive login from a copied `Cookie:` header. */
export async function loginWithCookieHeader(
  config: Config,
  cookieHeader: string,
): Promise<SessionState> {
  const cookies: StoredCookie[] = [];
  for (const part of cookieHeader.split(';').map((entry) => entry.trim()).filter(Boolean)) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    cookies.push({
      name: part.slice(0, index).trim(),
      value: part.slice(index + 1).trim(),
      domain: new URL(config.baseUrl).hostname,
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  }

  if (!cookies.length) throw new Error('No cookies found in the supplied header.');

  const state = emptyState(config.baseUrl);
  state.cookies = cookies;
  const probe = await probeSurfaces(config, state);
  const mode = pickApiMode(probe);
  if (!mode) {
    throw new Error(
      `The supplied cookies were rejected (internal ${probe.internal.status}, public ${probe.publicApi.status}).`,
    );
  }
  state.apiMode = mode;
  state.user = await exportUser(config, state);
  state.lastVerifiedAt = new Date().toISOString();
  state.updatedAt = state.lastVerifiedAt;
  writeState(config, state);
  return state;
}
