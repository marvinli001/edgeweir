import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    // The login form handles the second step itself (no redirect).
    twoFactorClient(),
    passkeyClient(),
  ],
});

export type Session = typeof authClient.$Infer.Session;
