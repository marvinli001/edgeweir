import { apiKeyClient } from "@better-auth/api-key/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    organizationClient(),
    apiKeyClient(),
    // The login form handles the second step itself (no redirect).
    twoFactorClient(),
    passkeyClient(),
  ],
});

export type Session = typeof authClient.$Infer.Session;
