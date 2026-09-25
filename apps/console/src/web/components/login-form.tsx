import { FingerPrintIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { OtpField } from "@/components/appica/otp-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/lib/i18n";

export type LoginResult = "done" | "two-factor" | string;

/**
 * Sign-in card. `onSubmit` returns "done", "two-factor" (then the card asks for the TOTP or a
 * backup code) or an error message.
 */
export function LoginForm({
  onSubmit,
  onVerify,
  onPasskey,
}: {
  onSubmit: (values: { email: string; password: string }) => Promise<LoginResult>;
  onVerify: (values: { code: string; backup: boolean }) => Promise<string | null>;
  onPasskey?: () => Promise<string | null>;
}) {
  const [step, setStep] = React.useState<"password" | "two-factor">("password");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [backup, setBackup] = React.useState(false);

  const run = async (fn: () => Promise<string | null>) => {
    setPending(true);
    setError(null);
    const failure = await fn();
    setPending(false);
    setError(failure);
  };
  const verify = (value: string) => run(() => onVerify({ code: value.trim(), backup }));

  if (step === "two-factor") {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{m.login_2fa_title()}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void verify(code);
            }}
          >
            <FieldGroup>
              {backup ? (
                <Field>
                  <FieldLabel htmlFor="backupCode">{m.login_backup_code()}</FieldLabel>
                  <Input
                    id="backupCode"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                    required
                    autoFocus
                  />
                </Field>
              ) : (
                <Field className="items-center">
                  <OtpField
                    value={code}
                    onValueChange={setCode}
                    onComplete={verify}
                    label={m.security_2fa_code()}
                    invalid={!!error}
                    autoFocus
                  />
                </Field>
              )}
              {error ? (
                <FieldError data-testid="login-error" className="animate-in fade-in">
                  {error}
                </FieldError>
              ) : null}
              <Button
                type="submit"
                disabled={pending || code.trim().length < 6}
                data-testid="verify-submit"
              >
                {pending ? <Spinner /> : null}
                {m.security_2fa_verify()}
              </Button>
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  setBackup(!backup);
                  setCode("");
                  setError(null);
                }}
              >
                {backup ? m.login_use_totp() : m.login_use_backup_code()}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{m.login_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void run(async () => {
              const result = await onSubmit({
                email: String(data.get("email") ?? ""),
                password: String(data.get("password") ?? ""),
              });
              if (result === "two-factor") {
                setStep("two-factor");
                return null;
              }
              return result === "done" ? null : result;
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">{m.login_email()}</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username webauthn"
                required
              />
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
            {onPasskey ? (
              <>
                <FieldSeparator>{m.login_or()}</FieldSeparator>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void run(onPasskey)}
                >
                  <HugeiconsIcon icon={FingerPrintIcon} strokeWidth={2} />
                  {m.login_passkey()}
                </Button>
              </>
            ) : null}
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
