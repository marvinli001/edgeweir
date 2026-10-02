import { type SmtpInput, smtpInput } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
export function SmtpSettings() {
  const query = useQuery(orpc.alerts.smtp.queryOptions());
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.alert_smtp_title()}</CardTitle>
      </CardHeader>
      {query.isPending ? (
        <LoadingState />
      ) : query.isLoadingError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <SmtpEditor key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
  );
}
function SmtpEditor({
  initial,
}: {
  initial: (Omit<SmtpInput, "password"> & { caFile: boolean }) | null;
}) {
  const { caFile = false, ...saved } = initial ?? {};
  const base = {
    host: "",
    port: 465,
    secure: true,
    from: "",
    username: "",
    ca: "",
    ...saved,
    password: "",
  };
  const [form, setForm] = React.useState(base),
    [error, setError] = React.useState<string | null>(null);
  const save = useMutation(orpc.alerts.setSmtp.mutationOptions());
  const queries = useQueryClient();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const data = smtpInput.safeParse({ ...form, password: form.password || undefined });
          if (!data.success) {
            setError(m.alert_check_fields());
            return;
          }
          await save.mutateAsync(data.data);
          await queries.invalidateQueries();
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {(["host", "from", "username", "password"] as const).map((key) => (
          <Field key={key}>
            <FieldLabel htmlFor={`smtp-${key}`}>
              {
                {
                  host: m.alert_smtp_host(),
                  from: m.alert_smtp_from(),
                  username: m.alert_smtp_username(),
                  password: m.alert_smtp_password(),
                }[key]
              }
            </FieldLabel>
            <Input
              id={`smtp-${key}`}
              type={key === "password" ? "password" : key === "from" ? "email" : "text"}
              required={key !== "password" || !initial}
              autoComplete={key === "password" ? "new-password" : "off"}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              placeholder={key === "password" && initial ? m.alert_keep_password() : undefined}
            />
          </Field>
        ))}
        <NumberField
          id="smtp-port"
          label={m.alert_smtp_port()}
          value={String(form.port)}
          min={1}
          max={65535}
          onChange={(port) => setForm({ ...form, port: Number(port) })}
        />
        <SwitchField
          id="smtp-secure"
          label={m.alert_smtp_tls()}
          checked={form.secure}
          onCheckedChange={(secure) => setForm({ ...form, secure })}
        />
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="smtp-ca">{m.alert_smtp_ca()}</FieldLabel>
          <Textarea
            id="smtp-ca"
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={form.ca}
            onChange={(e) => setForm({ ...form, ca: e.target.value })}
            placeholder={caFile ? "EDGEWEIR_SMTP_CA_FILE" : m.alert_smtp_ca_system()}
            className="min-h-20 font-mono text-xs"
            data-testid="smtp-ca"
          />
        </Field>
      </CardContent>
      <SaveBar
        dirty={JSON.stringify(base) !== JSON.stringify(form)}
        pending={save.isPending}
        error={error}
        testId="smtp-save"
      />
    </form>
  );
}
