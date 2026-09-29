import { ArrowLeft01Icon, FingerPrintIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { OtpField } from "@/components/appica/otp-field";
import { AuthViews } from "@/components/auth-views";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";

export type LoginResult = "done" | "two-factor" | string;

type View = "password" | "totp" | "backup";
/** Card order: moving right slides the cards one way, moving back the other. */
const VIEWS: readonly View[] = ["password", "totp", "backup"];

/**
 * Sign-in cards. `onSubmit` returns "done", "two-factor" (then the authenticator card swaps in,
 * with a backup-code card behind it) or an error message.
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
  const [view, setView] = React.useState<View>("password");
  const [email, setEmail] = React.useState("");
  const [codes, setCodes] = React.useState({ totp: "", backup: "" });
  // Each card keeps its own error, so an outgoing card leaves exactly as it was.
  const [error, setError] = React.useState<{ view: View; message: string } | null>(null);
  const action = useAction();
  const pending = action.pending;

  const run = async (from: View, work: () => Promise<string | null>) => {
    setError(null);
    let message: string | null;
    try {
      message = await action.run(work);
    } catch (err) {
      message = localizeError(err);
    }
    setError(message ? { view: from, message } : null);
  };
  const verify = (from: "totp" | "backup", value: string) =>
    run(from, () => onVerify({ code: value.trim(), backup: from === "backup" }));
  const errorFor = (v: View) =>
    error?.view === v ? (
      <FieldError data-testid="login-error" className="animate-in fade-in">
        {error.message}
      </FieldError>
    ) : null;

  const passwordCard = (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{m.login_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const values = {
              email: String(data.get("email") ?? ""),
              password: String(data.get("password") ?? ""),
            };
            void run("password", async () => {
              const result = await onSubmit(values);
              if (result === "two-factor") {
                setView("totp");
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
                value={email}
                onChange={(event) => setEmail(event.target.value)}
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
            {errorFor("password")}
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
                  onClick={() => void run("password", onPasskey)}
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

  const codeCard = (kind: "totp" | "backup") => {
    const code = codes[kind];
    const setCode = (value: string) => setCodes((all) => ({ ...all, [kind]: value }));
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{m.login_2fa_title()}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void verify(kind, code);
            }}
          >
            <FieldGroup>
              {kind === "backup" ? (
                <Field>
                  <FieldLabel htmlFor="backupCode">{m.login_backup_code()}</FieldLabel>
                  <Input
                    id="backupCode"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                    required
                  />
                </Field>
              ) : (
                <Field className="items-center">
                  <OtpField
                    value={code}
                    onValueChange={setCode}
                    onComplete={(value) => void verify("totp", value)}
                    label={m.security_2fa_code()}
                    invalid={error?.view === "totp"}
                  />
                </Field>
              )}
              {errorFor(kind)}
              <Button
                type="submit"
                disabled={pending || code.trim().length < 6}
                data-testid="verify-submit"
              >
                {pending ? <Spinner /> : null}
                {m.security_2fa_verify()}
              </Button>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="px-0"
                  onClick={() => setView("password")}
                >
                  <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                  {m.login_back()}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="px-0"
                  onClick={() => setView(kind === "backup" ? "totp" : "backup")}
                >
                  {kind === "backup" ? m.login_use_totp() : m.login_use_backup_code()}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    );
  };

  return (
    <AuthViews views={VIEWS} view={view}>
      {(v) => (v === "password" ? passwordCard : codeCard(v))}
    </AuthViews>
  );
}
