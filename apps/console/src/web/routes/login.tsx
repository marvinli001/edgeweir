import { DEMO_EMAIL, DEMO_PASSWORD } from "@edgeweir/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import * as z from "zod";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";
import { authClient } from "@/lib/auth-client";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/login")({
  // Loose: an MCP client's authorization request arrives here as signed query parameters.
  validateSearch: z.looseObject({ redirect: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(orpc.system.status.queryOptions());
    if (!status.initialized) throw redirect({ to: "/setup" });
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const enter = async (data?: unknown) => {
    // Resuming an authorization request: the auth client already sends the browser on.
    const next = data as { redirect?: boolean; url?: string } | null | undefined;
    if (next?.redirect && next.url) return;
    // Start from a clean cache: nothing of a previous account may show up.
    queryClient.clear();
    const target = search.redirect?.startsWith("/") ? search.redirect : "/overview";
    await navigate({ to: target });
  };
  const hasPasskeys = typeof window !== "undefined" && "PublicKeyCredential" in window;
  const status = useQuery(orpc.system.status.queryOptions());
  const signIn = async (email: string, password: string) => {
    const { data, error } = await authClient.signIn.email({ email, password });
    if (error) return localizeError(error, m.login_failed());
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return "two-factor";
    await enter(data);
    return "done";
  };
  return (
    <AuthShell>
      <LoginForm
        onSubmit={({ email, password }) => signIn(email, password)}
        onVerify={async ({ code, backup }) => {
          const { data, error } = backup
            ? await authClient.twoFactor.verifyBackupCode({ code })
            : await authClient.twoFactor.verifyTotp({ code });
          if (error) return localizeError(error, m.error_invalid_code());
          await enter(data);
          return null;
        }}
        onPasskey={
          hasPasskeys
            ? async () => {
                const result = await authClient.signIn.passkey();
                if (result?.error) return localizeError(result.error, m.login_failed());
                await enter(result?.data);
                return null;
              }
            : undefined
        }
        onDemo={
          status.data?.demo
            ? async () => {
                const result = await signIn(DEMO_EMAIL, DEMO_PASSWORD);
                return result === "done" ? null : result;
              }
            : undefined
        }
      />
    </AuthShell>
  );
}
