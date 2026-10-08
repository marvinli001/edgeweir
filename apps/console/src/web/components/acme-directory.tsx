import { acmeDirectoryInput } from "@edgeweir/contract";
import { SettingSourceBadge, SettingsCard } from "@/components/settings-card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * System page card: the custom ACME directory certificates can be requested
 * from besides Let's Encrypt, ZeroSSL and Google Trust Services. Each value
 * saved here wins over EDGEWEIR_ACME_DIRECTORY / EDGEWEIR_ACME_CA_FILE.
 */
export function AcmeDirectoryCard() {
  return (
    <SettingsCard
      title={m.system_acme_title()}
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
      testId="acme-directory"
      query={orpc.settings.acmeDirectory.queryOptions()}
      mutation={orpc.settings.setAcmeDirectory.mutationOptions()}
      refresh={orpc.settings.key()}
      toDraft={(s) => ({ url: s.url, eabKid: s.eabKid, eabHmacKey: "", caPem: s.caPem })}
      toInput={(d) => ({
        url: d.url.trim(),
        eabKid: d.eabKid.trim(),
        eabHmacKey: d.eabHmacKey.trim(),
        caPem: d.caPem.trim() ? `${d.caPem.trim()}\n` : "",
      })}
      check={(input) =>
        acmeDirectoryInput.safeParse(input).success ? null : m.system_acme_invalid()
      }
      noValidate
      contentClassName="grid gap-4 sm:grid-cols-2"
      saveTestId="acme-directory-save"
      errorTestId="acme-directory-error"
    >
      {({ value, draft, set, error }) => (
        <>
          <Field className="sm:col-span-2" data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="acme-directory-url" className="flex items-center gap-2">
              {m.system_acme_url()}
              <SettingSourceBadge source={value.source} testId="acme-directory-origin" />
            </FieldLabel>
            <Input
              id="acme-directory-url"
              type="url"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              value={draft.url}
              onChange={(event) => set({ url: event.target.value })}
              placeholder={value.effectiveUrl}
              aria-invalid={error ? true : undefined}
              className="font-mono text-sm"
              data-testid="acme-directory-url"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="acme-directory-eab-kid">{m.cert_eab_kid()}</FieldLabel>
            <Input
              id="acme-directory-eab-kid"
              autoComplete="off"
              spellCheck={false}
              value={draft.eabKid}
              onChange={(event) => set({ eabKid: event.target.value })}
              className="font-mono text-sm"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="acme-directory-eab-key">{m.cert_eab_key()}</FieldLabel>
            <Input
              id="acme-directory-eab-key"
              type="password"
              autoComplete="off"
              value={draft.eabHmacKey}
              onChange={(event) => set({ eabHmacKey: event.target.value })}
              placeholder={
                value.eabHmacKeySet && draft.eabKid.trim() === value.eabKid
                  ? m.site_secret_saved()
                  : undefined
              }
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="acme-directory-ca" className="flex items-center gap-2">
              {m.system_acme_ca()}
              <SettingSourceBadge source={value.caSource} testId="acme-directory-ca-origin" />
            </FieldLabel>
            <Textarea
              id="acme-directory-ca"
              rows={5}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              value={draft.caPem}
              onChange={(event) => set({ caPem: event.target.value })}
              data-testid="acme-directory-ca"
            />
          </Field>
          {value.caaIdentities.length ? (
            <p
              className="text-sm text-muted-foreground sm:col-span-2"
              data-testid="acme-directory-caa"
            >
              {m.system_acme_caa()}:{" "}
              <span className="font-mono">{value.caaIdentities.join(", ")}</span>
            </p>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}
