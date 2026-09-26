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
