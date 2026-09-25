import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import * as z from "zod";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";
import { authClient } from "@/lib/auth-client";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional() }),
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
  const enter = async () => {
    // Start from a clean cache: nothing of a previous account may show up.
    queryClient.clear();
    const target = search.redirect?.startsWith("/") ? search.redirect : "/overview";
    await navigate({ to: target });
  };
  const hasPasskeys = typeof window !== "undefined" && "PublicKeyCredential" in window;
  return (
    <AuthShell>
      <LoginForm
        onSubmit={async ({ email, password }) => {
          const { data, error } = await authClient.signIn.email({ email, password });
          if (error) return localizeError(error, m.login_failed());
          if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
            return "two-factor";
          }
          await enter();
          return "done";
        }}
        onVerify={async ({ code, backup }) => {
          const { error } = backup
            ? await authClient.twoFactor.verifyBackupCode({ code })
            : await authClient.twoFactor.verifyTotp({ code });
          if (error) return localizeError(error, m.error_invalid_code());
          await enter();
          return null;
        }}
        onPasskey={
          hasPasskeys
            ? async () => {
                const result = await authClient.signIn.passkey();
                if (result?.error) return localizeError(result.error, m.login_failed());
                await enter();
                return null;
              }
            : undefined
        }
      />
    </AuthShell>
  );
}
