import { smtpInput } from "@edgeweir/contract";
import type * as React from "react";
import { SettingsCard } from "@/components/settings-card";
import { NumberField, SwitchField } from "@/components/site/fields";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
/** The mail server of email alert channels. */
export function SmtpSettings({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <SettingsCard
      title={m.alert_smtp_title()}
      className={className}
      style={style}
      query={orpc.alerts.smtp.queryOptions()}
      mutation={orpc.alerts.setSmtp.mutationOptions()}
      // The saved password is never shown: empty keeps it.
      toDraft={(saved) => {
        const { caFile: _caFile, ...rest } = saved ?? {};
        return {
          host: "",
          port: 465,
          secure: true,
          from: "",
          username: "",
          ca: "",
          ...rest,
          password: "",
        };
      }}
      toInput={(d) => ({ ...d, password: d.password || undefined })}
      check={(input) => (smtpInput.safeParse(input).success ? null : m.alert_check_fields())}
      // Alert channels report a missing SMTP server too.
      refresh={orpc.alerts.key()}
      contentClassName="grid gap-4 sm:grid-cols-2"
      saveTestId="smtp-save"
    >
      {({ value, draft, set }) => (
        <>
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
                required={key !== "password" || !value}
                autoComplete={key === "password" ? "new-password" : "off"}
                value={draft[key]}
                onChange={(e) => set({ [key]: e.target.value })}
                placeholder={key === "password" && value ? m.alert_keep_password() : undefined}
              />
            </Field>
          ))}
          <NumberField
            id="smtp-port"
            label={m.alert_smtp_port()}
            value={String(draft.port)}
            min={1}
            max={65535}
            onChange={(port) => set({ port: Number(port) })}
          />
          <SwitchField
            id="smtp-secure"
            label={m.alert_smtp_tls()}
            checked={draft.secure}
            onCheckedChange={(secure) => set({ secure })}
          />
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="smtp-ca">{m.alert_smtp_ca()}</FieldLabel>
            <Textarea
              id="smtp-ca"
              rows={3}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={draft.ca}
              onChange={(e) => set({ ca: e.target.value })}
              placeholder={value?.caFile ? "EDGEWEIR_SMTP_CA_FILE" : m.alert_smtp_ca_system()}
              className="min-h-20 font-mono text-xs"
              data-testid="smtp-ca"
            />
          </Field>
        </>
      )}
    </SettingsCard>
  );
}
