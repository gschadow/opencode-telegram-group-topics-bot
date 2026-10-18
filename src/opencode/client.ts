import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../config.js";

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

export const opencodeClient = createOpencodeClient({
  baseUrl: config.opencode.apiUrl,
  headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
});

// Liveness probe. The bundled SDK's `global.health()` still targets the v1
// `/global/health`, which the v2 server removed (non-/api paths hit the web-UI
// fallback and 500). The v2 equivalent is `/api/info`. Return the same
// `{ data?, error? }` shape so existing call sites keep working.
export async function fetchServerInfo(): Promise<{
  data?: { healthy: boolean; version?: string };
  error?: unknown;
}> {
  try {
    const auth = getAuth();
    const response = await fetch(`${config.opencode.apiUrl.replace(/\/+$/, "")}/api/info`, {
      headers: auth ? { Authorization: auth } : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return { error: new Error(`Server info request failed: HTTP ${response.status}`) };
    }
    const body = (await response.json()) as { version?: string };
    return { data: { healthy: true, version: body.version } };
  } catch (error) {
    return { error };
  }
}

// The server's workspace routing ignores the `directory` field in the session
// creation body — it reads the working directory exclusively from the
// `x-opencode-directory` request header (or query parameter).  The generated
// SDK type doesn't expose `headers` on the session.create payload, so we cast
// through `unknown` here to inject the header without touching the SDK types.
type SessionCreatePayload = Parameters<typeof opencodeClient.session.create>[0];

export function sessionCreateInDirectory(
  directory: string,
  extra?: Omit<NonNullable<SessionCreatePayload>, "directory">,
) {
  // The server workspace-routing reads the working directory from the
  // x-opencode-directory header, not from the request body. The generated SDK
  // type doesn't expose headers on this payload, so we bypass it via cast.
  const payload = { ...extra, directory } as NonNullable<SessionCreatePayload>;
  return opencodeClient.session.create(payload, { headers: { "x-opencode-directory": directory } } as never);
}
