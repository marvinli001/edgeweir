import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <Logo />
          {m.app_name()}
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{m.setup_title()}</CardTitle>
            <CardDescription>{m.setup_description()}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const input = {
                  name: String(data.get("name") ?? ""),
                  email: String(data.get("email") ?? ""),
                  password: String(data.get("password") ?? ""),
                  organizationName: String(data.get("organizationName") ?? ""),
                };
                await setup.mutateAsync(input);
                await authClient.signIn.email({ email: input.email, password: input.password });
                toast.success(m.setup_done());
                await navigate({ to: "/" });
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="name">{m.setup_name()}</FieldLabel>
                  <Input id="name" name="name" required autoComplete="name" />
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
                  <FieldDescription>{m.setup_organization_hint()}</FieldDescription>
                </Field>
                {setup.isError ? (
                  <FieldError>{errorMessage(setup.error, m.common_unknown_error())}</FieldError>
                ) : null}
                <Button type="submit" disabled={setup.isPending} data-testid="setup-submit">
                  {setup.isPending ? <Spinner /> : null}
                  {m.setup_submit()}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
