import {
  BROTLI_LEVEL_RANGE,
  type CertificateDto,
  COMPRESSION_MIN_LENGTH_RANGE,
  type FeatureAvailability,
  type Site,
  type SiteFeatures,
  type TlsSettings,
  tlsSettings,
  ZSTD_LEVEL_RANGE,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export function HttpsTab({ site }: { site: Site }) {
  const policy = useQuery(orpc.https.get.queryOptions({ input: { id: site.id } }));
  const certificates = useQuery(orpc.certificates.list.queryOptions());
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  if (policy.isPending || certificates.isPending || features.isPending) return <LoadingState />;
  if (policy.isError)
    return <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />;
  if (certificates.isError)
    return <ErrorState error={certificates.error} onRetry={() => void certificates.refetch()} />;
  if (features.isError)
    return <ErrorState error={features.error} onRetry={() => void features.refetch()} />;
  return (
    <HttpsEditor
      key={JSON.stringify(policy.data)}
      site={site}
      initial={policy.data}
      certificates={certificates.data}
      features={features.data}
    />
  );
}

type Algorithm = "gzip" | "brotli" | "zstd";

/** The settings fields of each compression algorithm (gzip has no level). */
const ALGORITHMS = {
  gzip: { on: "gzip", level: null, min: "gzipMinLength", types: "gzipTypes" },
  brotli: {
    on: "brotli",
    level: { key: "brotliLevel", range: BROTLI_LEVEL_RANGE },
    min: "brotliMinLength",
    types: "brotliTypes",
  },
  zstd: {
    on: "zstd",
    level: { key: "zstdLevel", range: ZSTD_LEVEL_RANGE },
    min: "zstdMinLength",
    types: "zstdTypes",
  },
} as const;

const algorithmLabel = (algorithm: Algorithm) =>
  ({ gzip: m.cert_gzip, brotli: m.compression_brotli, zstd: m.compression_zstd })[algorithm]();

function HttpsEditor({
  site,
  initial,
  certificates,
  features,
}: {
  site: Site;
  initial: TlsSettings;
  certificates: CertificateDto[];
  features: SiteFeatures;
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
    ["ocspStapling", m.cert_ocsp()],
  ] as const;
  const availability: Record<Algorithm, FeatureAvailability> = {
    gzip: { available: true, reason: null },
    brotli: features.brotli,
    zstd: features.zstd,
  };
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
                .filter((c) => c.fingerprint && c.notAfter && Date.parse(c.notAfter) > Date.now())
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
        </CardContent>
        <CardContent className="flex flex-col gap-6 pt-6">
          <div className="border-t pt-6">
            <CardTitle>{m.compression_title()}</CardTitle>
          </div>
          {(["zstd", "brotli", "gzip"] as const).map((algorithm) => (
            <CompressionGroup
              key={algorithm}
              algorithm={algorithm}
              settings={settings}
              saved={initial}
              availability={availability[algorithm]}
              onChange={setSettings}
            />
          ))}
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

/**
 * Switch, level, minimum length and types of one algorithm. An algorithm the
 * cluster's nodes lack cannot be turned on (it can still be turned off).
 */
function CompressionGroup({
  algorithm,
  settings,
  saved,
  availability,
  onChange,
}: {
  algorithm: Algorithm;
  settings: TlsSettings;
  saved: TlsSettings;
  availability: FeatureAvailability;
  onChange: (next: TlsSettings) => void;
}) {
  const fields = ALGORITHMS[algorithm];
  const blocked = !availability.available && !saved[fields.on];
  // gzip keeps the ids it always had.
  const id = (suffix: string) => (algorithm === "gzip" ? `gzip${suffix}` : `${algorithm}${suffix}`);
  return (
    <FieldSet className="gap-0" data-testid={`compression-${algorithm}`}>
      <FieldLegend variant="label" className="text-muted-foreground">
        {algorithmLabel(algorithm)}
      </FieldLegend>
      {/* Shared columns (switch, level, minimum, types) line the algorithms up. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[8rem_8rem_11rem_minmax(0,1fr)]">
        <SwitchField
          id={algorithm}
          label={m.compression_enabled()}
          checked={settings[fields.on]}
          disabled={blocked}
          testId={`https-${algorithm}`}
          onCheckedChange={(value) => onChange({ ...settings, [fields.on]: value })}
        />
        {fields.level ? (
          <NumberField
            id={id("Level")}
            label={m.compression_level()}
            value={String(settings[fields.level.key])}
            min={fields.level.range.min}
            max={fields.level.range.max}
            step={1}
            required
            testId={`https-${algorithm}-level`}
            onChange={(value) =>
              fields.level && onChange({ ...settings, [fields.level.key]: Number(value) })
            }
          />
        ) : null}
        <div className={fields.level ? undefined : "lg:col-start-3"}>
          <NumberField
            id={id("Min")}
            label={m.cert_gzip_min()}
            value={String(settings[fields.min])}
            min={COMPRESSION_MIN_LENGTH_RANGE.min}
            max={COMPRESSION_MIN_LENGTH_RANGE.max}
            step={1}
            required
            testId={`https-${algorithm}-min`}
            onChange={(value) => onChange({ ...settings, [fields.min]: Number(value) })}
          />
        </div>
        <Field className={fields.level ? undefined : "sm:col-span-2 lg:col-span-1"}>
          <FieldLabel htmlFor={id("Types")}>{m.cert_gzip_types()}</FieldLabel>
          <Input
            id={id("Types")}
            value={settings[fields.types].join(", ")}
            data-testid={`https-${algorithm}-types`}
            onChange={(e) =>
              onChange({
                ...settings,
                [fields.types]: e.target.value.split(/[,\s]+/).filter(Boolean),
              })
            }
          />
        </Field>
      </div>
      {availability.available ? null : (
        <SafetyNote className="mt-2" data-testid={`https-${algorithm}-unavailable`}>
          {m.feature_unavailable_nodes()}
        </SafetyNote>
      )}
    </FieldSet>
  );
}
