import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://uaeu.blackboard.com';

export interface Config {
  baseUrl: string;
  stateDir: string;
  sessionFile: string;
  downloadDir: string;
  allowWrites: boolean;
  pageSize: number;
  timeoutMs: number;
  cacheTtlMs?: number;
  concurrency?: number;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
    accessToken?: string;
    expiresAt?: number;
  };
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function loadConfig(): Config {
  const baseUrl = (env('BB_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error(`BB_URL must be an https origin, got ${baseUrl}`);
  }

  const stateDir = env('BB_STATE_DIR') ?? path.join(os.homedir(), '.uaeu-blackboard-mcp');
  const downloadDir = env('BB_DOWNLOAD_DIR') ?? path.join(os.homedir(), 'Downloads', 'blackboard');

  const clientId = env('BB_CLIENT_ID');
  const clientSecret = env('BB_CLIENT_SECRET');

  return {
    baseUrl,
    stateDir,
    sessionFile: path.join(stateDir, 'session.json'),
    downloadDir,
    allowWrites: env('BB_ALLOW_WRITES') === '1' || env('BB_ALLOW_WRITES') === 'true',
    pageSize: intEnv('BB_PAGE_SIZE', 50, 1, 200),
    timeoutMs: intEnv('BB_TIMEOUT_MS', 30_000, 1_000, 120_000),
    cacheTtlMs: intEnv('BB_CACHE_TTL_MS', 15_000, 0, 60_000),
    concurrency: intEnv('BB_CONCURRENCY', 4, 1, 8),
    logLevel: (env('BB_LOG_LEVEL') as Config['logLevel']) ?? 'warn',
    oauth:
      clientId && clientSecret
        ? {
            clientId,
            clientSecret,
            refreshToken: env('BB_REFRESH_TOKEN'),
            accessToken: env('BB_ACCESS_TOKEN'),
          }
        : undefined,
  };
}
