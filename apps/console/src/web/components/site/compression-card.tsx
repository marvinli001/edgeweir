import {
  BROTLI_LEVEL_RANGE,
  COMPRESSION_MIN_LENGTH_RANGE,
  type FeatureAvailability,
  MIME_TYPE_RE,
  type Site,
  type TlsSettings,
  tlsSettings,
  ZSTD_LEVEL_RANGE,
} from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import { SafetyNote } from "@/components/safety-note";
import { ListInput, NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

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

/** The settings fields the compression card owns; the HTTPS tab owns the others. */
export const COMPRESSION_KEYS = [
  ...Object.values(ALGORITHMS).flatMap((fields) => [
    fields.on,
    fields.min,
    fields.types,
    ...(fields.level ? [fields.level.key] : []),
  ]),
  // site-content-v1: gzip's level (0: the nodes' default) and the largest compressed response.
  "gzipLevel",
  "compressMaxLength",
] as (keyof TlsSettings)[];

/** The compression fields of `settings`. */
export const compressionOf = (settings: TlsSettings) =>
  Object.fromEntries(COMPRESSION_KEYS.map((key) => [key, settings[key]])) as Partial<TlsSettings>;

/** What to check when the compression fields fail the contract, by the first issue's field. */
function compressionError(field: PropertyKey | undefined): string {
  for (const algorithm of ["gzip", "brotli", "zstd"] as const) {
    const fields = ALGORITHMS[algorithm];
    const label =
      field === fields.types
        ? m.cert_gzip_types()
        : field === fields.min
          ? m.cert_gzip_min()
          : field === fields.level?.key
            ? m.compression_level()
            : null;
    if (label) return m.common_check_field({ field: `${algorithmLabel(algorithm)} · ${label}` });
  }
  return m.error_bad_request();
}

/** Compression of the site's responses (stored with its HTTPS settings). */
export function CompressionCard({ site }: { site: Site }) {
  const policy = useQuery(orpc.https.get.queryOptions({ input: { id: site.id } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  return (
    <QueryView query={combineQueries(policy, features)}>
      {([saved, { brotli, zstd, siteContent }]) => (
        <CompressionEditor
          siteId={site.id}
          server={saved}
          availability={{ gzip: { available: true, reason: null }, brotli, zstd }}
          content={siteContent}
        />
      )}
    </QueryView>
  );
}

function CompressionEditor({
  siteId,
  server,
  availability,
  content,
}: {
  siteId: string;
  server: TlsSettings;
  availability: Record<Algorithm, FeatureAvailability>;
  /** gzip's level and the largest compressed response (site-content-v1). */
  content: FeatureAvailability;
}) {
  // The draft holds the compression fields only: saving HTTPS settings keeps unsaved edits here.
  const { draft, set, dirty, error, pending, submit } = useSettingsForm({
    value: server,
    toDraft: compressionOf,
    // The HTTPS fields as saved: the HTTPS tab owns them.
    toInput: (fields, saved) => ({ id: siteId, settings: { ...saved, ...fields } }),
    check: (input) => {
      const parsed = tlsSettings.safeParse(input.settings);
      return parsed.success ? null : compressionError(parsed.error.issues[0]?.path[0]);
    },
    mutation: { ...orpc.https.update.mutationOptions(), meta: { invalidates: "all" } },
  });
  const settings = { ...server, ...draft } as TlsSettings;
  const setSettings = (next: TlsSettings) => set(compressionOf(next));
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "120ms" }}
      data-testid="compression-card"
    >
      <form className="flex flex-col gap-(--card-spacing)" onSubmit={submit}>
        <CardHeader>
          <CardTitle>{m.compression_title()}</CardTitle>
        </CardHeader>
        {/* One algorithm per row and the largest compressed response last, split by hairlines. */}
        <CardContent className="flex flex-col divide-y divide-border [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          {/* Wrapped: a fieldset's legend would sit on the hairline. */}
          {(["zstd", "brotli", "gzip"] as const).map((algorithm) => (
            <div key={algorithm}>
              <CompressionGroup
                algorithm={algorithm}
                settings={settings}
                saved={server}
                availability={availability[algorithm]}
                content={content}
                onChange={setSettings}
              />
            </div>
          ))}
          <div>
            <div className="w-full sm:w-64">
              <NumberField
                id="compressMaxLength"
                label={m.compression_max_length()}
                value={settings.compressMaxLength ? String(settings.compressMaxLength) : ""}
                min={0}
                step={1}
                placeholder={m.compression_no_limit()}
                disabled={!content.available && !server.compressMaxLength}
                testId="compression-max-length"
                onChange={(value) =>
                  setSettings({ ...settings, compressMaxLength: value.trim() ? Number(value) : 0 })
                }
              />
            </div>
          </div>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="compression-save" />
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
  content,
  onChange,
}: {
  algorithm: Algorithm;
  settings: TlsSettings;
  saved: TlsSettings;
  availability: FeatureAvailability;
  content: FeatureAvailability;
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
        ) : (
          // gzip: empty keeps the nodes' default level (1); 1-9 need site-content-v1.
          <NumberField
            id="gzipLevel"
            label={m.compression_level()}
            value={settings.gzipLevel ? String(settings.gzipLevel) : ""}
            min={1}
            max={9}
            step={1}
            placeholder={m.compression_default()}
            disabled={!content.available && !saved.gzipLevel}
            testId="https-gzip-level"
            onChange={(value) =>
              onChange({ ...settings, gzipLevel: value.trim() ? Number(value) : 0 })
            }
          />
        )}
        <div>
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
        <Field>
          <FieldLabel htmlFor={id("Types")}>{m.cert_gzip_types()}</FieldLabel>
          <ListInput
            id={id("Types")}
            value={settings[fields.types]}
            invalid={settings[fields.types].some((type) => !MIME_TYPE_RE.test(type))}
            testId={`https-${algorithm}-types`}
            onChange={(types) => onChange({ ...settings, [fields.types]: types })}
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
