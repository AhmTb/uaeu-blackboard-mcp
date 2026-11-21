import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { loginScope, readLoginPreferences, updateLoginPreferences } from './preferences.js';

export interface SavedLogin {
  username: string;
  password: string;
  usernameOrigin: string;
  passwordOrigin: string;
}

export function trustedLoginOrigin(config: Config, value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return;
    const allowed = [new URL(config.baseUrl).origin, 'https://login.microsoftonline.com',
      'https://login.microsoft.com', 'https://sts.uaeu.ac.ae', 'https://adfs.uaeu.ac.ae',
      ...(config.loginOrigins ?? [])];
    return allowed.includes(url.origin) ? url.origin : undefined;
  } catch { return; }
}

function validLogin(config: Config, value: unknown): value is SavedLogin {
  if (!value || typeof value !== 'object') return false;
  const login = value as SavedLogin;
  return typeof login.username === 'string' && login.username.length > 0 && login.username.length <= 512 &&
    typeof login.password === 'string' && login.password.length > 0 && login.password.length <= 4096 &&
    trustedLoginOrigin(config, login.usernameOrigin) === login.usernameOrigin &&
    trustedLoginOrigin(config, login.passwordOrigin) === login.passwordOrigin;
}

async function entry(config: Config) {
  // Load native keyring support only for people who opt into remembering a login.
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const directory = path.resolve(config.stateDir);
  const scope = createHash('sha256').update(process.platform === 'win32' ? directory.toLowerCase() : directory).digest('hex').slice(0, 24);
  return new AsyncEntry('uaeu-blackboard-mcp', `${loginScope(config)}:${scope}`, { linux: { store: 'secret-service' } });
}

export async function readSavedLogin(config: Config): Promise<SavedLogin | undefined> {
  try {
    const raw = await (await entry(config)).getPassword(AbortSignal.timeout(5_000));
    if (!raw) return;
    const login: unknown = JSON.parse(raw);
    return validLogin(config, login) ? login : undefined;
  } catch {
    throw new Error('The OS credential store is unavailable or locked. Unlock it or use manual sign-in.');
  }
}

export async function saveLogin(config: Config, login: SavedLogin): Promise<void> {
  if (!validLogin(config, login)) throw new Error('Cannot remember credentials from an untrusted login origin.');
  try {
    await (await entry(config)).setPassword(JSON.stringify(login), AbortSignal.timeout(5_000));
  } catch {
    throw new Error('Could not save the login in the OS credential store. No plaintext password was written.');
  }
  updateLoginPreferences(config, { credentialsBlocked: false });
}

export async function forgetLogin(config: Config): Promise<void> {
  // Disable first, including when deletion fails because the vault is locked.
  updateLoginPreferences(config, { autoLogin: false, rememberLogin: false, credentialsBlocked: true });
  try {
    await (await entry(config)).deletePassword(AbortSignal.timeout(5_000));
  } catch {
    throw new Error('Automatic sign-in is off, but the OS credential store could not delete the saved login. Unlock it and run auto-login forget again.');
  }
}

export async function loginSettings(config: Config) {
  const prefs = readLoginPreferences(config);
  let savedLogin: boolean | 'unavailable';
  try { savedLogin = Boolean(await readSavedLogin(config)); } catch { savedLogin = 'unavailable'; }
  return { ...prefs, effectiveAutoLogin: config.autoLogin ?? prefs.autoLogin,
    environmentOverride: config.autoLogin ?? null, savedLogin };
}
