import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { AuthFrame, AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { authClient } from "@/lib/auth-client";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery({
      ...orpc.system.status.queryOptions(),
      staleTime: 0,
    });
    if (status.initialized) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useMutation(orpc.system.setup.mutationOptions());
  const signIn = useAction();
  const pending = setup.isPending || signIn.pending;
  return (
    <AuthShell className="max-w-md">
      <AuthFrame>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">{m.setup_title()}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const input = {
                  setupToken: String(data.get("setupToken") ?? "").trim(),
                  name: String(data.get("adminName") ?? ""),
                  email: String(data.get("email") ?? ""),
                  password: String(data.get("password") ?? ""),
                };
                try {
                  await setup.mutateAsync(input);
                } catch {
                  return; // rendered below via setup.error
                }
                await signIn.run(async () => {
                  await authClient.signIn.email({ email: input.email, password: input.password });
                  // The cached status still says "not initialized"; start from a clean cache.
                  queryClient.clear();
                  toast.success(m.setup_done());
                  await navigate({ to: "/overview" });
                });
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="setupToken">{m.setup_token()}</FieldLabel>
                  <Input
                    id="setupToken"
                    name="setupToken"
                    required
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    placeholder={m.setup_token_placeholder()}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="adminName">{m.setup_name()}</FieldLabel>
                  <Input id="adminName" name="adminName" required autoComplete="name" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="email">{m.setup_email()}</FieldLabel>
                  <Input id="email" name="email" type="email" required autoComplete="username" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">{m.setup_password()}</FieldLabel>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    minLength={12}
                    required
                    autoComplete="new-password"
                    placeholder={m.setup_password_placeholder()}
                  />
                </Field>
                {setup.isError ? (
                  <FieldError data-testid="setup-error">{errorMessage(setup.error)}</FieldError>
                ) : null}
                <Button type="submit" disabled={pending} data-testid="setup-submit">
                  {pending ? <Spinner /> : null}
                  {m.setup_submit()}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </AuthFrame>
    </AuthShell>
  );
}
