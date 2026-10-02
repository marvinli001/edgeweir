import type { DnsProviderDto } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import type { DialogProps } from "@/hooks/use-dialog-state";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
import { fieldLabel, optionLabel, providerLabel } from "./labels";

/** A DNS account for cluster DNS, or a DNS credential for DNS-01 certificates. */
export type DnsCredentialScope = "account" | "credential";
export type EditableCredential = {
  id: string;
  name: string;
  provider: string;
  zone: string;
};
type CatalogField = DnsProviderDto["fields"][number];

/** The provider catalog (static; fetched once). */
export function useDnsCatalog(enabled = true) {
  return useQuery({
    ...orpc.dns.catalog.queryOptions(),
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  });
}

/** Capability badges of a provider: lines, apex CNAME, self-hosted endpoint. */
export function CapabilityBadges({ provider }: { provider?: DnsProviderDto }) {
  if (!provider) return null;
  const { lines, apex, endpoint } = provider.capabilities;
  return (
    <span className="flex flex-wrap gap-1">
      {lines.length > 1 ? <Badge variant="secondary">{m.dns_capability_lines()}</Badge> : null}
      {apex ? <Badge variant="secondary">{m.dns_capability_apex()}</Badge> : null}
      {endpoint === "custom" ? (
        <Badge variant="secondary">{m.dns_capability_custom()}</Badge>
      ) : null}
    </span>
  );
}

/**
 * Creates or edits DNS credentials: a DNS account for cluster DNS or a
 * DNS credential for DNS-01 certificates. The fields come from the provider catalog;
 * the connection can be tested and the zone picked from the account's zones
 * before saving. Saved credentials are never shown again: editing replaces
 * all of them.
 */
export function DnsCredentialDialog({
  scope,
  initial,
  testEnabled = false,
  open,
  onOpenChange,
  onSaved,
}: {
  scope: DnsCredentialScope;
  initial?: EditableCredential;
  testEnabled?: boolean;
  onSaved: () => Promise<void>;
} & DialogProps) {
  const catalog = useDnsCatalog(open);
  const providers = (catalog.data ?? []).filter(
    (p) => p.id !== "test" || (scope === "account" && testEnabled),
  );
  const [provider, setProvider] = React.useState(initial?.provider ?? "cloudflare");
  const [zone, setZone] = React.useState(initial?.zone ?? "");
  const [zones, setZones] = React.useState<string[] | null>(null);
  const [selects, setSelects] = React.useState<Record<string, string>>({});
  const [rotate, setRotate] = React.useState(!initial);
  const [probe, setProbe] = React.useState<{ ok: boolean; text: string } | null>(null);
  // The credentials failed their test on saving: the next submit saves them anyway.
  const [saveAnyway, setSaveAnyway] = React.useState(false);
  const testing = useAction(),
    listing = useAction();
  const entry = providers.find((p) => p.id === provider);
  const credentialsOf = (form: HTMLFormElement | FormData | null) => {
    const data = form instanceof FormData ? form : form ? new FormData(form) : new FormData();
    return Object.fromEntries(
      (entry?.fields ?? [])
        .map((f) => [f.key, String(data.get(f.key) ?? "")] as const)
        .filter(([, value]) => value !== ""),
    );
  };
  const source = (form: HTMLFormElement | FormData | null) =>
    initial && !rotate
      ? { id: initial.id }
      : { provider: provider as DnsProviderDto["id"], credentials: credentialsOf(form) };
  /** Tests the credentials as entered (or the saved ones) against the zone; throws on failure. */
  const runTest = (form: HTMLFormElement | FormData | null) => {
    const target = initial && !rotate ? { id: initial.id } : { ...source(form), zone };
    return testing.run(() =>
      scope === "account"
        ? client.dns.testProvider(target as never)
        : client.dnsCredentials.test(target as never),
    );
  };
  const listZones = async (form: HTMLFormElement | null) => {
    setProbe(null);
    try {
      const found = await listing.run(() =>
        scope === "account"
          ? client.dns.zones(source(form))
          : client.dnsCredentials.zones(source(form) as never),
      );
      setZones(found.zones);
      if (!zone && found.zones[0]) setZone(found.zones[0]);
      setProbe({ ok: true, text: m.dns_zones_found({ count: found.zones.length }) });
    } catch (error) {
      setProbe({ ok: false, text: errorMessage(error) });
    }
  };
  const test = async (form: HTMLFormElement | null) => {
    setProbe(null);
    try {
      const result = await runTest(form);
      setProbe({ ok: true, text: m.dns_test_ok({ records: result.records }) });
    } catch (error) {
      setProbe({ ok: false, text: errorMessage(error) });
    }
  };
  return (
    <FormDialog
      open={open}
      title={
        initial ? m.common_edit() : scope === "account" ? m.dns_add_account() : m.cert_dns_add()
      }
      submitLabel={saveAnyway ? m.dns_save_anyway() : initial ? m.common_save() : m.common_create()}
      submitTestId="dns-credential-submit"
      onOpenChange={onOpenChange}
      onSubmit={async (data) => {
        // New credentials are tested before they are saved; a rename alone is not.
        if ((!initial || rotate) && !saveAnyway) {
          setProbe(null);
          try {
            const result = await runTest(data);
            setProbe({ ok: true, text: m.dns_test_ok({ records: result.records }) });
          } catch (error) {
            setProbe({ ok: false, text: errorMessage(error) });
            setSaveAnyway(true);
            return;
          }
        }
        const name = String(data.get("dns-credential-name"));
        const credentials = rotate
          ? Object.fromEntries(
              (entry?.fields ?? [])
                .map((f) => [f.key, String(data.get(f.key) ?? "")] as const)
                .filter(([, value]) => value !== ""),
            )
          : undefined;
        if (scope === "account") {
          if (initial) await client.dns.updateProvider({ id: initial.id, name, credentials });
          else
            await client.dns.createProvider({
              name,
              zone,
              provider: provider as DnsProviderDto["id"],
              credentials: credentials ?? {},
            });
        } else if (initial)
          await client.dnsCredentials.update({ id: initial.id, name, credentials });
        else
          await client.dnsCredentials.create({
            name,
            zone,
            provider: provider as never,
            credentials: credentials ?? {},
          });
        await onSaved();
        onOpenChange(false);
      }}
    >
      <QueryView query={catalog}>
        {() => (
          // Any edit asks for a new test before saving.
          <div className="contents" onChange={() => setSaveAnyway(false)}>
            <Field>
              <FieldLabel htmlFor="dns-credential-name">{m.cert_name()}</FieldLabel>
              <Input
                id="dns-credential-name"
                name="dns-credential-name"
                required
                maxLength={100}
                defaultValue={initial?.name}
              />
            </Field>
            <FormSelect
              id="dns-provider-kind"
              label={m.cert_dns_provider()}
              value={provider}
              disabled={!!initial}
              onChange={(value) => {
                setProvider(value);
                setZones(null);
                setSelects({});
                setProbe(null);
                setSaveAnyway(false);
              }}
              options={providers.map((p) => ({ value: p.id, label: providerLabel(p.id) }))}
            />
            <CapabilityBadges provider={entry} />
            {initial ? (
              <SwitchField
                id="dns-rotate"
                label={m.dns_rotate_credentials()}
                checked={rotate}
                onCheckedChange={setRotate}
                className="self-start"
              />
            ) : null}
            {rotate
              ? (entry?.fields ?? []).map((field) => (
                  <CredentialField
                    key={`${provider}-${field.key}`}
                    field={field}
                    value={selects[field.key] ?? field.default ?? field.options?.[0] ?? ""}
                    onSelect={(value) => setSelects({ ...selects, [field.key]: value })}
                  />
                ))
              : null}
            <Field>
              <FieldLabel htmlFor="dns-zone">{m.dns_zone()}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {zones?.length && !initial ? (
                  // Listed zones replace the text field: one zone field either way.
                  <OptionSelect
                    id="dns-zone"
                    value={zone}
                    options={zones.map((z) => ({ value: z, label: z }))}
                    onChange={setZone}
                    className="min-w-0 flex-1"
                    testId="dns-zone-select"
                  />
                ) : (
                  <Input
                    id="dns-zone"
                    name="dns-zone"
                    className="min-w-0 flex-1"
                    required
                    disabled={!!initial}
                    value={zone}
                    onChange={(e) => setZone(e.target.value.trim().toLowerCase())}
                    data-testid="dns-zone-input"
                  />
                )}
                {!initial && entry?.capabilities.listZones ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={listing.pending}
                    onClick={(e) => void listZones(e.currentTarget.form)}
                    data-testid="dns-list-zones"
                  >
                    {listing.pending ? <Spinner /> : null}
                    {m.dns_list_zones()}
                  </Button>
                ) : null}
              </div>
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={testing.pending || !zone}
                onClick={(e) => void test(e.currentTarget.form)}
                data-testid="dns-test-connection"
              >
                {testing.pending ? <Spinner /> : null}
                {m.dns_test_connection()}
              </Button>
              {probe ? (
                <SafetyNote
                  role="status"
                  data-testid="dns-probe-result"
                  className={cn("min-w-0 flex-1 animate-enter", !probe.ok && "text-destructive")}
                >
                  {probe.text}
                </SafetyNote>
              ) : null}
            </div>
          </div>
        )}
      </QueryView>
    </FormDialog>
  );
}

function CredentialField({
  field,
  value,
  onSelect,
}: {
  field: CatalogField;
  value: string;
  onSelect: (value: string) => void;
}) {
  const id = `dns-field-${field.key}`;
  const label = (
    <FieldLabel htmlFor={id}>
      {fieldLabel(field.key)}
      {field.required ? null : (
        <span className="font-normal text-muted-foreground">{m.dns_optional()}</span>
      )}
    </FieldLabel>
  );
  if (field.type === "select")
    return (
      <>
        <FormSelect
          id={id}
          label={fieldLabel(field.key)}
          value={value}
          onChange={onSelect}
          options={(field.options ?? []).map((option) => ({
            value: option,
            label: optionLabel(option),
          }))}
        />
        <input type="hidden" name={field.key} value={value} />
      </>
    );
  return (
    <Field>
      {label}
      {field.type === "textarea" ? (
        <Textarea
          id={id}
          name={field.key}
          required={field.required}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          rows={6}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <Input
          id={id}
          name={field.key}
          required={field.required}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          type={field.secret ? "password" : field.type === "url" ? "url" : "text"}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Field>
  );
}
