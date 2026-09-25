import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import * as z from "zod";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";
import { authClient } from "@/lib/auth-client";
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
  const search = Route.useSearch();
  return (
    <AuthShell>
      <LoginForm
        onSubmit={async ({ email, password }) => {
          const { error } = await authClient.signIn.email({ email, password });
          if (error) return m.login_failed();
          const target = search.redirect?.startsWith("/") ? search.redirect : "/";
          await navigate({ to: target });
          return null;
        }}
      />
    </AuthShell>
  );
}
