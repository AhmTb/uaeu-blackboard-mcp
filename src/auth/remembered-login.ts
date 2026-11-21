import type { BrowserContext, Frame, Request } from 'playwright-core';
import type { Config } from '../config.js';
import { readSavedLogin, saveLogin, trustedLoginOrigin, type SavedLogin } from './credentials.js';
import { readLoginPreferences, rememberLoginEnabled, updateLoginPreferences } from './preferences.js';

const USER_FIELDS = ['loginfmt', 'login', 'username', 'user_id', 'email'];
const PASSWORD_FIELDS = ['passwd', 'password'];
const USER_SELECTOR = 'input[name="loginfmt"], input[name="UserName"], input[name="username"], input[name="user_id"], input[autocomplete="username"], input[type="email"]';
const PASSWORD_SELECTOR = 'input[type="password"]:not([autocomplete="new-password"])';
const SUBMIT_SELECTOR = '#idSIButton9, #submitButton, input[type="submit"], button[type="submit"]';

/** Capture only submitted password fields on explicitly trusted HTTPS origins. */
export function submittedLogin(config: Config, request: Pick<Request, 'url' | 'method' | 'postData' | 'headers'>) {
  const origin = trustedLoginOrigin(config, request.url());
  if (!origin || request.method() !== 'POST') return;
  const body = request.postData();
  if (!body || body.length > 65_536) return;
  const contentType = request.headers()['content-type'] ?? '';
  let fields: Record<string, unknown>;
  try {
    fields = contentType.includes('application/json') ? JSON.parse(body)
      : contentType.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : {};
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return;
  } catch { return; }
  const normalized = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
  const field = (names: string[], max: number) => names.map(name => normalized[name])
    .find((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= max);
  return { origin, username: field(USER_FIELDS, 512), password: field(PASSWORD_FIELDS, 4096) };
}

export class RememberedLogin {
  private saved?: SavedLogin;
  private username?: string;
  private usernameOrigin?: string;
  private candidate?: SavedLogin;
  private passwordAttempted = false;
  private usernameAttempts = new Set<string>();

  private constructor(private readonly config: Config) {}

  get hasSavedLogin(): boolean { return Boolean(this.saved); }

  static async create(config: Config): Promise<RememberedLogin> {
    const flow = new RememberedLogin(config);
    if (rememberLoginEnabled(config) && !readLoginPreferences(config).credentialsBlocked) {
      try { flow.saved = await readSavedLogin(config); }
      catch { process.stderr.write('Saved login is unavailable; continuing with SSO or manual sign-in.\n'); }
    }
    return flow;
  }

  attach(context: BrowserContext): () => void {
    if (!rememberLoginEnabled(this.config)) return () => {};
    const capture = (request: Request) => {
      if (!rememberLoginEnabled(this.config)) return;
      const fields = submittedLogin(this.config, request);
      if (!fields) return;
      if (fields.username) {
        this.username = fields.username;
        this.usernameOrigin = fields.origin;
      }
      if (fields.password && this.username && this.usernameOrigin) {
        this.candidate = { username: this.username, password: fields.password,
          usernameOrigin: this.usernameOrigin, passwordOrigin: fields.origin };
      }
    };
    context.on('request', capture);
    return () => context.off('request', capture);
  }

  resetCapture(): void {
    // A failed hidden login must not be saved after a different manual login.
    this.candidate = undefined;
    this.username = undefined;
    this.usernameOrigin = undefined;
    if (this.passwordAttempted) this.saved = undefined;
    else this.usernameAttempts.clear();
  }

  async fill(context: BrowserContext): Promise<void> {
    const saved = this.saved;
    if (!saved || this.passwordAttempted || !rememberLoginEnabled(this.config) ||
      readLoginPreferences(this.config).credentialsBlocked) return;
    // Credentials never go into subframes, even on an otherwise trusted origin.
    for (const page of context.pages()) {
      const frame = page.mainFrame();
      const origin = trustedLoginOrigin(this.config, frame.url());
      if (!origin || ![saved.usernameOrigin, saved.passwordOrigin].includes(origin)) continue;
      try {
        const password = frame.locator(PASSWORD_SELECTOR).first();
        const username = frame.locator(USER_SELECTOR).first();
        const hasPassword = origin === saved.passwordOrigin && await password.isVisible();
        const hasUsername = await username.isVisible();
        if (!hasPassword && (!hasUsername || this.usernameAttempts.has(origin))) continue;
        const existingUsername = hasUsername ? await username.inputValue({ timeout: 1_000 }) : '';
        if (existingUsername) {
          // A person choosing another account must not receive the saved password.
          if (existingUsername.toLowerCase() !== saved.username.toLowerCase()) continue;
        } else if (hasUsername) {
          await username.fill(saved.username, { timeout: 1_000 });
        }
        if (!rememberLoginEnabled(this.config) || readLoginPreferences(this.config).credentialsBlocked) return;
        if (hasPassword) {
          this.passwordAttempted = true;
          // An interrupted/rejected attempt stays blocked across calls and restarts.
          updateLoginPreferences(this.config, { credentialsBlocked: true });
          this.username = saved.username;
          this.usernameOrigin = saved.usernameOrigin;
          await password.fill(saved.password, { timeout: 1_000 });
        } else {
          this.usernameAttempts.add(origin);
        }
        await this.submit(frame, hasPassword ? PASSWORD_SELECTOR : USER_SELECTOR);
      } catch {
        // Navigation can replace the form mid-fill; never retry a password submit.
      }
    }
  }

  private async submit(frame: Frame, field: string): Promise<void> {
    const button = frame.locator(SUBMIT_SELECTOR).first();
    if (await button.isVisible()) await button.click({ timeout: 1_000, noWaitAfter: true });
    else await frame.locator(field).first().press('Enter', { timeout: 1_000, noWaitAfter: true });
  }

  async verified(): Promise<void> {
    if (!rememberLoginEnabled(this.config)) return;
    if (this.candidate) {
      try {
        await saveLogin(this.config, this.candidate);
        process.stderr.write('Login remembered in the OS credential store.\n');
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'Could not remember login.'}\n`);
      }
    } else if (this.passwordAttempted && this.saved) {
      updateLoginPreferences(this.config, { credentialsBlocked: false });
    }
  }
}
