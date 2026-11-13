import type { Config } from '../config.js';
import type { SessionState } from '../state.js';
import { cookieHeaderFor } from '../state.js';

export interface EndpointProbe {
  ok: boolean;
  status: number;
  contentType?: string;
  body?: unknown;
  error?: string;
}

export interface ProbeResult {
  internal: EndpointProbe;
  publicApi: EndpointProbe;
  version?: unknown;
}

async function probeOne(url: string, cookie: string, timeoutMs: number): Promise<EndpointProbe> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 400);
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? undefined,
      body,
    };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Determine which API surface the captured session can use.
 * Blackboard exposes the documented `/learn/api/public/v1` API (OAuth or session)
 * and the Ultra client API `/learn/api/v1` (session only).
 */
export async function probeSurfaces(
  config: Config,
  state: SessionState,
): Promise<ProbeResult> {
  const cookie = cookieHeaderFor(state, config.baseUrl);
  const internalUrl = `${config.baseUrl}/learn/api/v1/users/me`;
  const publicUrl = `${config.baseUrl}/learn/api/public/v1/users/me`;

  const [internal, publicApi, version] = await Promise.all([
    probeOne(internalUrl, cookie, config.timeoutMs),
    probeOne(publicUrl, cookie, config.timeoutMs),
    probeOne(`${config.baseUrl}/learn/api/public/v1/system/version`, '', config.timeoutMs),
  ]);

  return { internal, publicApi, version: version.ok ? version.body : undefined };
}

export function pickApiMode(result: ProbeResult): 'internal' | 'public' | undefined {
  if (result.internal.ok) return 'internal';
  if (result.publicApi.ok) return 'public';
  return undefined;
}
