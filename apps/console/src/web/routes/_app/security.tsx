import { Delete02Icon, FingerPrintIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { OtpField } from "@/components/appica/otp-field";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { enterDelay, Page } from "@/components/page";
import { QrCode } from "@/components/qr-code";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { authClient } from "@/lib/auth-client";
import { localizeError } from "@/lib/errors";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/security")({
  component: SecurityPage,
});

/** better-auth client calls resolve to { data, error }; turn errors into exceptions. */
async function unwrap<T>(
  promise: Promise<{ data: T | null; error: { code?: string; message?: string } | null }>,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw Object.assign(new Error(error.message ?? ""), { code: error.code });
  return data as T;
}

function SecurityPage() {
  const me = useQuery(orpc.account.me.queryOptions());
  return (
    <Page title={m.security_title()}>
      {/* Short forms keep a narrow column, at the start of the page column like the title. */}
      <div className="flex w-full max-w-[56rem] flex-col gap-6">
        <PasswordCard />
        <QueryView query={me}>
          {({ user }) => <TwoFactorCard enabled={user.twoFactorEnabled} />}
        </QueryView>
        <PasskeysCard />
      </div>
    </Page>
  );
}

function PasswordCard() {
  const action = useAction();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Card className="animate-enter">
      {/* A settings card: the title, the fields, and the submit in a footer row. */}
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const next = String(data.get("newPassword") ?? "");
          if (next !== String(data.get("confirmPassword") ?? "")) {
            setError(m.security_password_mismatch());
            return;
          }
          setError(null);
          try {
            await action.run(() =>
              unwrap(
                authClient.changePassword({
                  currentPassword: String(data.get("currentPassword") ?? ""),
                  newPassword: next,
                  revokeOtherSessions: true,
                }),
              ),
            );
            form.reset();
            toast.success(m.security_password_changed());
          } catch (err) {
            setError(localizeError(err));
          }
        }}
      >
        <CardHeader>
          <CardTitle>{m.security_password()}</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="max-w-sm">
            <Field>
              <FieldLabel htmlFor="currentPassword">{m.security_current_password()}</FieldLabel>
              <Input
                id="currentPassword"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="newPassword">{m.security_new_password()}</FieldLabel>
              <Input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                placeholder={m.setup_password_placeholder()}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="confirmPassword">{m.security_confirm_password()}</FieldLabel>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-3 border-t">
          {error ? <FieldError className="mr-auto animate-in fade-in">{error}</FieldError> : null}
          <Button type="submit" disabled={action.pending}>
            {action.pending ? <Spinner /> : null}
            {m.security_change_password()}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

type Enrollment = { totpURI: string; backupCodes: string[] };

function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = React.useState<Enrollment | null>(null);
  const [backupCodes, setBackupCodes] = React.useState<string[] | null>(null);
  const [code, setCode] = React.useState("");
  const action = useAction();
  const pending = action.pending;
  const [error, setError] = React.useState<string | null>(null);
  const secret = enrollment ? (new URL(enrollment.totpURI).searchParams.get("secret") ?? "") : "";

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await action.run(fn);
    } catch (err) {
      setError(localizeError(err));
    }
  };
  const refresh = () => queryClient.invalidateQueries();

  const verify = (value: string) =>
    run(async () => {
      await unwrap(authClient.twoFactor.verifyTotp({ code: value }));
      setBackupCodes(enrollment?.backupCodes ?? []);
      setEnrollment(null);
      setCode("");
      toast.success(m.security_2fa_enabled());
      await refresh();
    });

  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <CardHeader className="flex flex-row items-center gap-3">
        <CardTitle className="flex-1">{m.security_2fa()}</CardTitle>
        <StatusDot tone={enabled ? "good" : "idle"} data-testid="two-factor-status">
          <span className={enabled ? "font-medium" : "text-muted-foreground"}>
            {enabled ? m.members_2fa_on() : m.members_2fa_off()}
          </span>
        </StatusDot>
      </CardHeader>
      {backupCodes ? (
        <CardContent className="animate-enter">
          <Field>
            <FieldLabel>{m.security_backup_codes()}</FieldLabel>
            <CodeBlock value={backupCodes.join("\n")} testId="backup-codes" />
            <SafetyNote>{m.enroll_shown_once()}</SafetyNote>
          </Field>
        </CardContent>
      ) : null}
      {/* Each step ends in a footer row with its submit, like the other settings cards. */}
      {enrollment ? (
        <>
          <CardContent className="flex flex-col items-center gap-5 animate-enter sm:flex-row sm:items-start">
            <QrCode value={enrollment.totpURI} label={m.security_2fa_qr()} />
            <FieldGroup className="min-w-0">
              <Field>
                <FieldLabel>{m.security_2fa_secret()}</FieldLabel>
                <CodeBlock value={secret} testId="totp-secret" />
              </Field>
              <Field>
                <FieldLabel>{m.security_2fa_code()}</FieldLabel>
                <OtpField
                  value={code}
                  onValueChange={setCode}
                  onComplete={verify}
                  label={m.security_2fa_code()}
                  invalid={!!error}
                  autoFocus
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-3 border-t">
            {error ? <FieldError className="mr-auto animate-in fade-in">{error}</FieldError> : null}
            <Button
              disabled={pending || code.length < 6}
              onClick={() => verify(code)}
              data-testid="verify-totp"
            >
              {pending ? <Spinner /> : null}
              {m.security_2fa_verify()}
            </Button>
          </CardFooter>
        </>
      ) : (
        <form
          className="flex flex-col gap-(--card-spacing)"
          onSubmit={(event) => {
            event.preventDefault();
            const password = String(new FormData(event.currentTarget).get("twoFactorPassword"));
            void run(async () => {
              if (enabled) {
                await unwrap(authClient.twoFactor.disable({ password }));
                setBackupCodes(null);
                toast.success(m.security_2fa_disabled());
                await refresh();
              } else {
                const data = await unwrap(authClient.twoFactor.enable({ password }));
                setEnrollment({
                  totpURI: (data as { totpURI: string }).totpURI,
                  backupCodes: (data as { backupCodes: string[] }).backupCodes,
                });
              }
            });
          }}
        >
          <CardContent>
            <Field className="max-w-sm">
              <FieldLabel htmlFor="twoFactorPassword">{m.security_current_password()}</FieldLabel>
              <Input
                id="twoFactorPassword"
                name="twoFactorPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-3 border-t">
            {error ? <FieldError className="mr-auto animate-in fade-in">{error}</FieldError> : null}
            <Button
              type="submit"
              variant={enabled ? "destructive" : "default"}
              disabled={pending}
              data-testid="toggle-2fa"
            >
              {pending ? <Spinner /> : null}
              {enabled ? m.security_2fa_disable() : m.security_2fa_enable()}
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}

interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
  deviceType?: string;
}

function PasskeysCard() {
  const queryClient = useQueryClient();
  const passkeys = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () =>
      ((await unwrap(authClient.passkey.listUserPasskeys())) ?? []) as unknown as PasskeyRow[],
  });
  const add = useMutation({
    mutationFn: async (name: string) => {
      const result = await authClient.passkey.addPasskey({ name });
      if (result?.error) {
        throw Object.assign(new Error(result.error.message ?? ""), {
          code: (result.error as { code?: string }).code,
        });
      }
    },
    onSuccess: () => {
      toast.success(m.security_passkey_added());
      return queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    },
  });
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  return (
    <Card className="animate-enter" style={{ animationDelay: "120ms" }}>
      <CardHeader>
        <CardTitle>{m.security_passkeys()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get("passkeyName") ?? "").trim();
            add.mutate(name || m.security_passkey_default_name());
          }}
        >
          <Field className="w-full sm:w-64">
            <FieldLabel htmlFor="passkeyName">{m.settings_api_key_name()}</FieldLabel>
            <Input id="passkeyName" name="passkeyName" maxLength={64} placeholder="MacBook" />
          </Field>
          <Button type="submit" disabled={add.isPending || !supported}>
            {add.isPending ? <Spinner /> : <HugeiconsIcon icon={FingerPrintIcon} strokeWidth={2} />}
            {m.security_passkey_add()}
          </Button>
        </form>
        {add.isError ? <FieldError>{localizeError(add.error)}</FieldError> : null}
        <QueryView
          query={passkeys}
          loadingClassName="min-h-24"
          empty={<EmptyState icon={FingerPrintIcon} title={m.security_passkeys_empty()} />}
        >
          {(list) => (
            <ul
              className="divide-y divide-edge rounded-2xl text-sm sunk-well"
              data-testid="passkeys"
            >
              {list.map((key, index) => (
                <li
                  key={key.id}
                  className="flex min-h-12 items-center gap-3 px-3 py-1.5 animate-enter"
                  style={enterDelay(index)}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-muted-foreground shadow-elev-1">
                    <HugeiconsIcon icon={FingerPrintIcon} strokeWidth={2} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {key.name || m.security_passkey_default_name()}
                  </span>
                  {key.createdAt ? (
                    <span
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      title={formatDateTime(new Date(key.createdAt).toISOString())}
                    >
                      {timeAgo(new Date(key.createdAt).toISOString())}
                    </span>
                  ) : null}
                  <ConfirmDialog
                    trigger={
                      <Button size="icon-sm" variant="ghost" aria-label={m.common_delete()}>
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      </Button>
                    }
                    destructive
                    title={m.security_passkey_delete({ name: key.name || "" })}
                    confirmLabel={m.common_delete()}
                    onConfirm={async () => {
                      await unwrap(authClient.passkey.deletePasskey({ id: key.id }));
                      await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}
