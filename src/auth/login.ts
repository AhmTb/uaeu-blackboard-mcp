import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resourceUrl } from '../bb/resources.js';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { Config } from '../config.js';
import {
  emptyState,
  readState,
  writeState,
  type SessionState,
  type SessionUser,
  type StoredCookie,
} from '../state.js';
import { pickApiMode, probeSurfaces, type ProbeResult } from '../bb/probe.js';
import { automaticLoginEnabled } from './preferences.js';
import { RememberedLogin } from './remembered-login.js';

const SESSION_COOKIE = 'BbRouter';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function log(message: string): void {
  process.stderr.write(message + '\n');
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

async function launchBrowser(config: Config, headless = false): Promise<BrowserContext> {
  fs.mkdirSync(profileDir(config), { recursive: true });
  const channels = ['msedge', 'chrome'] as const;
  let lastError: unknown;

  for (const channel of channels) {
    try {
      const context = await chromium.launchPersistentContext(profileDir(config), {
        channel,
        headless,
        viewport: { width: 1280, height: 900 },
        args: ['--no-first-run', '--no-default-browser-check'],
      });
      try {
        // Chromium discards session-only SSO cookies when the browser closes.
        const saved = readState(browserSessionConfig(config));
        if (saved?.baseUrl === config.baseUrl) {
          const cookies = saved.cookies.filter(cookie => cookie.expires <= 0 || cookie.expires > Date.now() / 1000);
          if (cookies.length) await context.addCookies(cookies);
        }
        return context;
      } catch (error) {
        await context.close().catch(() => undefined);
        throw error;
      }
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

function browserSessionConfig(config: Config): Config {
  return { ...config, sessionFile: path.join(config.stateDir, 'browser-session.json') };
}

async function followSsoLink(config: Config, context: BrowserContext, attempted: WeakSet<Page>): Promise<void> {
  for (const page of context.pages()) {
    try {
      if (attempted.has(page) || new URL(page.url()).origin !== new URL(config.baseUrl).origin) continue;
      // Blackboard can stop at a login chooser instead of redirecting to its IdP.
      const link = page.locator('a[href*="/auth-saml/saml/SSO/"]').first();
      if (!await link.isVisible()) continue;
      const target = new URL(await link.getAttribute('href') ?? '', config.baseUrl);
      if (target.origin !== new URL(config.baseUrl).origin || !target.pathname.startsWith('/auth-saml/saml/SSO/')) continue;
      attempted.add(page);
      await link.click({ timeout: 1_000, noWaitAfter: true });
    } catch {
      // A redirect can remove the chooser while it is being inspected.
    }
  }
}

async function captureSession(config: Config, context: BrowserContext): Promise<SessionState | undefined> {
  const cookies = await context.cookies();
  const hostname = new URL(config.baseUrl).hostname;
  const candidate = emptyState(config.baseUrl);
  candidate.cookies = toStoredCookies(cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '');
    return hostname === domain || hostname.endsWith('.' + domain);
  }));
  if (!candidate.cookies.some(cookie => cookie.name === SESSION_COOKIE && cookie.value)) return;
  const probe = await probeSurfaces(config, candidate);
  const mode = pickApiMode(probe);
  if (!mode) return;
  candidate.apiMode = mode;
  candidate.user = await exportUser(config, candidate, probe);
  candidate.lastVerifiedAt = new Date().toISOString();
  candidate.updatedAt = candidate.lastVerifiedAt;
  // Keep IdP cookies local to browser recovery, separate from API credentials.
  writeState(browserSessionConfig(config), { ...candidate, cookies: toStoredCookies(await context.cookies()) });
  writeState(config, candidate);
  return candidate;
}

/** Bounded recovery with saved SSO and opt-in credentials; no interactive window. */
export async function restoreSession(config: Config, flow?: RememberedLogin): Promise<SessionState | undefined> {
  if (!automaticLoginEnabled(config)) return undefined;
  flow ??= await RememberedLogin.create(config);
  if (fs.existsSync(profileDir(config)) || flow.hasSavedLogin) {
    let context: BrowserContext | undefined;
    let detach: (() => void) | undefined;
    try {
      context = await launchBrowser(config, true);
      detach = flow.attach(context);
      const page = context.pages()[0] ?? await context.newPage();
      const deadline = Date.now() + 20_000;
      const ssoAttempts = new WeakSet<Page>();
      await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      while (Date.now() < deadline) {
        if (!automaticLoginEnabled(config)) return undefined;
        const state = await captureSession({ ...config, timeoutMs: Math.min(config.timeoutMs, Math.max(1, deadline - Date.now())) }, context);
        if (state) { await flow.verified(); return state; }
        await followSsoLink(config, context, ssoAttempts);
        await flow.fill(context);
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    } catch {
      // Expired SSO, MFA, or a blocked headless browser needs the normal window.
    } finally {
      detach?.();
      await context?.close().catch(() => undefined);
    }
  }
  return undefined;
}

/** Reuse the existing SSO profile before asking for another interactive sign-in. */
export async function recoverSession(config: Config): Promise<SessionState> {
  const checkEnabled = () => {
    if (!automaticLoginEnabled(config)) {
      throw new Error('Automatic sign-in is disabled. Run `uaeu-blackboard-mcp login` to sign in manually, or `uaeu-blackboard-mcp auto-login on` to enable it.');
    }
  };
  checkEnabled();
  const flow = await RememberedLogin.create(config);
  const restored = await restoreSession(config, flow);
  if (restored) return restored;
  checkEnabled();
  flow.resetCapture();
  return loginInteractive(config, flow, true);
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

async function exportUser(config: Config, state: SessionState, result?: ProbeResult): Promise<SessionUser | undefined> {
  const probe = result ?? await probeSurfaces(config, state);
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
export async function loginInteractive(config: Config, flow?: RememberedLogin, automatic = false): Promise<SessionState> {
  flow ??= await RememberedLogin.create(config);
  const context = await launchBrowser(config);
  const detach = flow.attach(context);

  try {
    const page: Page = context.pages()[0] ?? (await context.newPage());
    log('');
    log('  A browser window is open. Sign in to UAEU Blackboard (SSO + MFA).');
    log('  This window stays open until the session is captured. Up to 10 minutes.');
    log('');

    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let state: SessionState | undefined;
    let lastNote = 0;
    const ssoAttempts = new WeakSet<Page>();

    while (Date.now() < deadline) {
      if (automatic && !automaticLoginEnabled(config)) throw new Error('Automatic sign-in was disabled. Run login to sign in manually.');
      if (!context.browser()?.isConnected() && context.pages().length === 0) {
        throw new Error('The browser was closed before a session was captured.');
      }

      state = await captureSession(config, context);
      if (state) break;
      if (automaticLoginEnabled(config)) await followSsoLink(config, context, ssoAttempts);
      await flow.fill(context);

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
    await flow.verified();

    log('');
    log(`  Signed in as ${state.user?.displayName ?? state.user?.userName ?? 'unknown user'}`);
    log(`  Instance:  ${state.baseUrl}`);
    log(`  API mode:  ${state.apiMode}`);
    log(`  Session:   ${config.sessionFile}`);
    log('');
    return state;
  } finally {
    detach();
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
