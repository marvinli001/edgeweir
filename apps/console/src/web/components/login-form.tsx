import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/lib/i18n";

export function LoginForm({
  onSubmit,
}: {
  onSubmit: (values: { email: string; password: string }) => Promise<string | null>;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{m.login_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setPending(true);
            setError(null);
            const failure = await onSubmit({
              email: String(data.get("email") ?? ""),
              password: String(data.get("password") ?? ""),
            });
            setPending(false);
            setError(failure);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">{m.login_email()}</FieldLabel>
              <Input id="email" name="email" type="email" autoComplete="username" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">{m.login_password()}</FieldLabel>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            {error ? (
              <FieldError data-testid="login-error" className="animate-in fade-in">
                {error}
              </FieldError>
            ) : null}
            <Button type="submit" disabled={pending} data-testid="login-submit">
              {pending ? <Spinner /> : null}
              {m.login_submit()}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
