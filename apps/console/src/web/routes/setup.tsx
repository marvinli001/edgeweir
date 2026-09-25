import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
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
  const setup = useMutation(orpc.system.setup.mutationOptions());
  const [signingIn, setSigningIn] = React.useState(false);
  const pending = setup.isPending || signingIn;
  return (
    <AuthShell className="max-w-md">
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
                name: String(data.get("adminName") ?? ""),
                email: String(data.get("email") ?? ""),
                password: String(data.get("password") ?? ""),
                organizationName: String(data.get("organizationName") ?? ""),
              };
              try {
                await setup.mutateAsync(input);
              } catch {
                return; // rendered below via setup.error
              }
              setSigningIn(true);
              try {
                await authClient.signIn.email({ email: input.email, password: input.password });
                toast.success(m.setup_done());
                await navigate({ to: "/" });
              } finally {
                setSigningIn(false);
              }
            }}
          >
            <FieldGroup>
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
              <Field>
                <FieldLabel htmlFor="organizationName">{m.setup_organization()}</FieldLabel>
                <Input
                  id="organizationName"
                  name="organizationName"
                  required
                  defaultValue="Default"
                />
              </Field>
              {setup.isError ? (
                <FieldError>{errorMessage(setup.error, m.common_unknown_error())}</FieldError>
              ) : null}
              <Button type="submit" disabled={pending} data-testid="setup-submit">
                {pending ? <Spinner /> : null}
                {m.setup_submit()}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
