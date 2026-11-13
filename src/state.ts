import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export type ApiMode = 'internal' | 'public' | 'oauth';

export interface SessionUser {
  id: string;
  userName?: string;
  displayName?: string;
  email?: string;
}

export interface SessionState {
  version: 1;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  cookies: StoredCookie[];
  user?: SessionUser;
  apiMode?: ApiMode;
  lastVerifiedAt?: string;
  oauth?: {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: string;
  };
}

export function readState(config: Config): SessionState | null {
  try {
    const raw = fs.readFileSync(config.sessionFile, 'utf8');
    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cookies)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeState(config: Config, state: SessionState): void {
  fs.mkdirSync(path.dirname(config.sessionFile), { recursive: true });
  const tmp = `${config.sessionFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, config.sessionFile);
  try {
    fs.chmodSync(config.sessionFile, 0o600);
  } catch {
    // Windows does not implement POSIX modes; the file inherits user-profile ACLs.
  }
}

export function emptyState(baseUrl: string): SessionState {
  const now = new Date().toISOString();
  return { version: 1, baseUrl, createdAt: now, updatedAt: now, cookies: [] };
}

/** Cookies that apply to `url`, in a `Cookie:` header value. */
export function cookieHeaderFor(state: SessionState, url: string): string {
  const target = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  const host = target.hostname.toLowerCase();
  const pathname = target.pathname || '/';

  return state.cookies
    .filter((cookie) => {
      if (cookie.expires > 0 && cookie.expires < now) return false;
      if (cookie.secure && target.protocol !== 'https:') return false;
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      if (host !== domain && !host.endsWith('.' + domain)) return false;
      return pathname.startsWith(cookie.path || '/');
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}
