import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import * as z from "zod";
import { LoginForm } from "@/components/login-form";
import { Logo } from "@/components/logo";
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
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <Logo />
          {m.app_name()}
        </div>
        <LoginForm
          onSubmit={async ({ email, password }) => {
            const { error } = await authClient.signIn.email({ email, password });
            if (error) return m.login_failed();
            const target = search.redirect?.startsWith("/") ? search.redirect : "/";
            await navigate({ to: target });
            return null;
          }}
        />
      </div>
    </div>
  );
}
