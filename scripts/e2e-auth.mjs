/** Keep the real sign-in limiter enabled when several E2E stories share one client IP. */
export async function signInResponse(base, email, password) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email, password }),
    });
    if (response.status !== 429 || attempt >= 3) return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 11_000));
  }
}

/** A console RPC call with the session cookie and the CSRF header, as the web UI makes it. */
export async function rpc(base, cookie, path, input) {
  const response = await fetch(`${base}/rpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "orpc", cookie },
    body: JSON.stringify({ json: input }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`/rpc/${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body.json;
}

/**
 * Signs in and creates an AccessKey for /api/v1. Keys are created through the
 * console's RPC only (a session, never another key); `revokeAccessKey` removes it.
 */
export async function signInWithAccessKey(base, email, password, name, scope = "write") {
  const response = await signInResponse(base, email, password);
  if (response.status !== 200)
    throw new Error(`sign-in of ${email}: HTTP ${response.status} ${await response.text()}`);
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const created = await rpc(base, cookie, "accessKeys/create", { name, scope });
  return { key: created.key, id: created.id, cookie };
}

export async function revokeAccessKey(base, session) {
  await rpc(base, session.cookie, "accessKeys/revoke", { id: session.id });
}
