import { type CertificateDto, type Site, type TlsSettings, tlsSettings } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect } from "@/components/form-select";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export function HttpsTab({ site }: { site: Site }) {
  const policy = useQuery(orpc.https.get.queryOptions({ input: { id: site.id } }));
  const certificates = useQuery(orpc.certificates.list.queryOptions());
  if (policy.isPending || certificates.isPending) return <LoadingState />;
  if (policy.isError)
    return <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />;
  if (certificates.isError)
    return <ErrorState error={certificates.error} onRetry={() => void certificates.refetch()} />;
  return (
    <HttpsEditor
      key={JSON.stringify(policy.data)}
      site={site}
      initial={policy.data}
      certificates={certificates.data}
    />
  );
}

function HttpsEditor({
  site,
  initial,
  certificates,
}: {
  site: Site;
  initial: TlsSettings;
  certificates: CertificateDto[];
}) {
  const [settings, setSettings] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const mutation = useMutation(orpc.https.update.mutationOptions());
  const client = useQueryClient();
  const flags = [
    ["forceHttps", m.cert_force_https()],
    ["http2", m.cert_http2()],
    ["http3", m.cert_http3()],
    ["hstsIncludeSubdomains", m.cert_hsts_subdomains()],
    ["hstsPreload", m.cert_hsts_preload()],
    ["gzip", m.cert_gzip()],
    ["ocspStapling", m.cert_ocsp()],
  ] as const;
  return (
    <Card>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setError(null);
          try {
            await mutation.mutateAsync({ id: site.id, settings: tlsSettings.parse(settings) });
            await client.invalidateQueries();
            toast.success(m.common_saved());
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setPending(false);
          }
        }}
      >
        <CardContent className="grid gap-5 pt-6 sm:grid-cols-2">
          <FormSelect
            id="siteCertificate"
            label={m.cert_title()}
            value={settings.certificateId ?? "none"}
            options={[
              { value: "none", label: m.cert_none() },
              ...certificates
                .filter(
                  (c) =>
                    c.organizationId === site.organizationId &&
                    c.fingerprint &&
                    c.notAfter &&
                    Date.parse(c.notAfter) > Date.now(),
                )
                .map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={(value) =>
              setSettings((old) =>
                value === "none"
                  ? { ...old, certificateId: null, forceHttps: false, hstsMaxAge: 0 }
                  : { ...old, certificateId: value },
              )
            }
          />
          <FormSelect
            id="minimumTls"
            label={m.cert_min_tls()}
            value={settings.minimumVersion}
            onChange={(value) =>
              setSettings({ ...settings, minimumVersion: value as "1.2" | "1.3" })
            }
            options={[
              { value: "1.2", label: m.cert_tls12() },
              { value: "1.3", label: m.cert_tls13() },
            ]}
          />
          <FormSelect
            id="cipherProfile"
            label={m.cert_ciphers()}
            value={settings.cipherProfile}
            onChange={(value) =>
              setSettings({ ...settings, cipherProfile: value as "modern" | "compatible" })
            }
            options={[
              { value: "modern", label: m.cert_modern() },
              { value: "compatible", label: m.cert_compatible() },
            ]}
          />
          <NumberField
            id="hstsAge"
            label={m.cert_hsts_age()}
            value={String(settings.hstsMaxAge)}
            min={0}
            max={63072000}
            disabled={!settings.certificateId}
            onChange={(value) => setSettings({ ...settings, hstsMaxAge: Number(value) })}
          />
          {flags.map(([key, label]) => (
            <SwitchField
              key={key}
              id={key}
              label={label}
              checked={settings[key]}
              disabled={key === "forceHttps" && !settings.certificateId}
              onCheckedChange={(value) => setSettings({ ...settings, [key]: value })}
            />
          ))}
          <NumberField
            id="gzipMin"
            label={m.cert_gzip_min()}
            value={String(settings.gzipMinLength)}
            min={1}
            max={1048576}
            onChange={(value) => setSettings({ ...settings, gzipMinLength: Number(value) })}
          />
          <Field>
            <FieldLabel htmlFor="gzipTypes">{m.cert_gzip_types()}</FieldLabel>
            <Input
              id="gzipTypes"
              value={settings.gzipTypes.join(", ")}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  gzipTypes: e.target.value.split(/[,\s]+/).filter(Boolean),
                })
              }
            />
          </Field>
          <SwitchField
            id="brotli"
            label={m.cert_brotli_unavailable()}
            checked={false}
            disabled
            onCheckedChange={() => {}}
          />
          <SwitchField
            id="zstd"
            label={m.cert_zstd_unavailable()}
            checked={false}
            disabled
            onCheckedChange={() => {}}
          />
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(settings) !== JSON.stringify(initial)}
          pending={pending}
          error={error}
          testId="https-save"
        />
      </form>
    </Card>
  );
}
