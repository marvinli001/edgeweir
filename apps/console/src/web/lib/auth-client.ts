import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    // The login form handles the second step itself (no redirect).
    twoFactorClient(),
    passkeyClient(),
    // On /login?<signed authorization request> (MCP, ADR-0076) every sign-in POST carries the
    // request, and the answer sends the browser on to the consent page or the client.
    oauthProviderClient(),
  ],
});

export type Session = typeof authClient.$Infer.Session;
