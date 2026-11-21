import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';

export interface LoginPreferences {
  autoLogin: boolean;
  rememberLogin: boolean;
  credentialsBlocked: boolean;
}

export function loginScope(config: Config): string {
  return createHash('sha256').update(new URL(config.baseUrl).origin).digest('hex').slice(0, 24);
}

function settingsFile(config: Config): string {
  return path.join(config.stateDir, `login-settings-${loginScope(config)}.json`);
}

export function readLoginPreferences(config: Config): LoginPreferences {
  try {
    const value = JSON.parse(fs.readFileSync(settingsFile(config), 'utf8'));
    if (value?.version !== 1 || typeof value.autoLogin !== 'boolean' ||
      typeof value.rememberLogin !== 'boolean' || typeof value.credentialsBlocked !== 'boolean') {
      throw new Error('Invalid login settings');
    }
    return { autoLogin: value.autoLogin, rememberLogin: value.rememberLogin, credentialsBlocked: value.credentialsBlocked };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { autoLogin: true, rememberLogin: false, credentialsBlocked: false };
    }
    // Unreadable preferences must never opt somebody into credential capture.
    return { autoLogin: false, rememberLogin: false, credentialsBlocked: true };
  }
}

export function updateLoginPreferences(config: Config, patch: Partial<LoginPreferences>): LoginPreferences {
  const next = { ...readLoginPreferences(config), ...patch };
  fs.mkdirSync(config.stateDir, { recursive: true });
  const file = settingsFile(config);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, ...next }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return next;
}

export function automaticLoginEnabled(config: Config): boolean {
  return config.autoLogin ?? readLoginPreferences(config).autoLogin;
}

export function rememberLoginEnabled(config: Config): boolean {
  return automaticLoginEnabled(config) && readLoginPreferences(config).rememberLogin;
}
