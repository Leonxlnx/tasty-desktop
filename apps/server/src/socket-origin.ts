const allowedOrigins = new Set([
  "http://127.0.0.1:1420",
  "http://localhost:1420",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
]);

export function isAllowedSocketOrigin(origin: string | undefined): boolean {
  return origin !== undefined && allowedOrigins.has(origin);
}

export function isAuthorizedSocketRequest(origin: string | undefined, requestUrl: string | undefined, expectedToken: string | undefined): boolean {
  if (!isAllowedSocketOrigin(origin)) return false;
  if (!expectedToken) return true;
  try {
    return new URL(requestUrl ?? "", "ws://127.0.0.1").searchParams.get("token") === expectedToken;
  } catch {
    return false;
  }
}
