import {
  type AnalyticsRange,
  type FeatureAvailability,
  IMAGE_QUALITY_RANGE,
  type ImageConvertSettings,
  imageConvertSettings,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  type Site,
} from "@edgeweir/contract";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { ANALYTICS_RANGES, rangeLabel } from "@/lib/analytics";
import { formatBytes, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** Labels of the numeric fields, for the message of a value out of range. */
const fieldLabel = (field: PropertyKey | undefined): string | null =>
  (
    ({
      webpQuality: () => `${m.image_convert_webp()} · ${m.image_convert_quality()}`,
      avifQuality: () => `${m.image_convert_avif()} · ${m.image_convert_quality()}`,
      maxSize: m.image_convert_max_size,
      maxPixels: m.image_convert_max_pixels,
    }) as Record<PropertyKey, () => string>
  )[field as string]?.() ?? null;

/** What to fix when the settings fail the contract, by the first issue. */
function settingsError(issue: { path: PropertyKey[]; code: string } | undefined): string {
  const field = issue?.path[0];
  if (issue?.code === "custom") {
    if (field === "webp") return m.image_convert_no_format();
    if (field === "jpeg") return m.image_convert_no_source();
    if (field === "minSize") return m.image_convert_size_order();
  }
  if (field === "minSize") return m.common_check_field({ field: m.image_convert_min_size() });
  const label = fieldLabel(field);
  return label ? m.common_check_field({ field: label }) : m.error_bad_request();
}

/** WebP / AVIF conversion of the site's cached JPEG and PNG responses. */
export function ImageConvertCard({ site }: { site: Site }) {
  const settings = useQuery(orpc.imageConvert.get.queryOptions({ input: { id: site.id } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  return (
    <QueryView query={combineQueries(settings, features)}>
      {([saved, { imageConvert }]) => (
        <ImageConvertEditor
          // Keyed by what was saved: a save elsewhere keeps unsaved edits here.
          key={JSON.stringify(saved)}
          siteId={site.id}
          server={saved}
          availability={imageConvert}
        />
      )}
    </QueryView>
  );
}

function ImageConvertEditor({
  siteId,
  server,
  availability,
}: {
  siteId: string;
  server: ImageConvertSettings;
  availability: FeatureAvailability;
}) {
  const [draft, setDraft] = React.useState(server);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const mutation = useMutation(orpc.imageConvert.update.mutationOptions());
  const client = useQueryClient();
  const dirty = JSON.stringify(draft) !== JSON.stringify(server);
  // Nodes that lack the feature: it cannot be turned on (it can be turned off).
  const blocked = !availability.available && !server.enabled;
  const set = (patch: Partial<ImageConvertSettings>) => setDraft({ ...draft, ...patch });
  const number = (value: string) => (value.trim() ? Number(value) : Number.NaN);
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "160ms" }}
      data-testid="image-convert-card"
    >
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          const parsed = imageConvertSettings.safeParse(draft);
          if (!parsed.success) {
            setError(settingsError(parsed.error.issues[0]));
            return;
          }
          setPending(true);
          setError(null);
          try {
            await mutation.mutateAsync({ id: siteId, ...parsed.data });
            await client.invalidateQueries();
            toast.success(m.common_saved());
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setPending(false);
          }
        }}
      >
        <CardHeader>
          <CardTitle>{m.image_convert_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-border [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          <div className="flex flex-col gap-2">
            <SwitchField
              id="image-convert-enabled"
              label={m.compression_enabled()}
              checked={draft.enabled}
              disabled={blocked}
              className="self-start"
              testId="image-convert-enabled"
              onCheckedChange={(enabled) => set({ enabled })}
            />
            <SafetyNote>{m.image_convert_cached_only()}</SafetyNote>
            {availability.available ? null : (
              <SafetyNote data-testid="image-convert-unavailable">
                {m.feature_unavailable_nodes()}
              </SafetyNote>
            )}
          </div>
          {(["webp", "avif"] as const).map((format) => (
            <div key={format}>
              <FieldSet className="gap-0" data-testid={`image-convert-${format}`}>
                <FieldLegend variant="label" className="text-muted-foreground">
                  {format === "webp" ? m.image_convert_webp() : m.image_convert_avif()}
                </FieldLegend>
                <div className="grid gap-4 sm:grid-cols-[8rem_8rem]">
                  <SwitchField
                    id={`image-convert-${format}-on`}
                    label={m.compression_enabled()}
                    checked={draft[format]}
                    testId={`image-convert-${format}-on`}
                    onCheckedChange={(on) => set({ [format]: on })}
                  />
                  <NumberField
                    id={`image-convert-${format}-quality`}
                    label={m.image_convert_quality()}
                    value={String(draft[`${format}Quality`])}
                    min={IMAGE_QUALITY_RANGE.min}
                    max={IMAGE_QUALITY_RANGE.max}
                    step={1}
                    required
                    testId={`image-convert-${format}-quality`}
                    onChange={(value) => set({ [`${format}Quality`]: number(value) })}
                  />
                </div>
              </FieldSet>
            </div>
          ))}
          <div>
            <FieldSet className="gap-0" data-testid="image-convert-sources">
              <FieldLegend variant="label" className="text-muted-foreground">
                {m.image_convert_sources()}
              </FieldLegend>
              <div className="grid gap-4 sm:grid-cols-[8rem_8rem]">
                <SwitchField
                  id="image-convert-jpeg"
                  label={m.image_convert_jpeg()}
                  checked={draft.jpeg}
                  testId="image-convert-jpeg"
                  onCheckedChange={(jpeg) => set({ jpeg })}
                />
                <SwitchField
                  id="image-convert-png"
                  label={m.image_convert_png()}
                  checked={draft.png}
                  testId="image-convert-png"
                  onCheckedChange={(png) => set({ png })}
                />
              </div>
            </FieldSet>
          </div>
          <div>
            <FieldSet className="gap-0" data-testid="image-convert-limits">
              <FieldLegend variant="label" className="text-muted-foreground">
                {m.image_convert_limits()}
              </FieldLegend>
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField
                  id="image-convert-min-size"
                  label={m.image_convert_min_size()}
                  value={String(draft.minSize)}
                  min={0}
                  max={MAX_IMAGE_SIZE}
                  step={1}
                  required
                  testId="image-convert-min-size"
                  onChange={(value) => set({ minSize: number(value) })}
                />
                <NumberField
                  id="image-convert-max-size"
                  label={m.image_convert_max_size()}
                  value={String(draft.maxSize)}
                  min={1}
                  max={MAX_IMAGE_SIZE}
                  step={1}
                  required
                  testId="image-convert-max-size"
                  onChange={(value) => set({ maxSize: number(value) })}
                />
                <NumberField
                  id="image-convert-max-pixels"
                  label={m.image_convert_max_pixels()}
                  value={String(draft.maxPixels)}
                  min={1}
                  max={MAX_IMAGE_PIXELS}
                  step={1}
                  required
                  testId="image-convert-max-pixels"
                  onChange={(value) => set({ maxPixels: number(value) })}
                />
              </div>
            </FieldSet>
          </div>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="image-convert-save" />
      </form>
    </Card>
  );
}

/** Bytes the site's WebP / AVIF responses saved over a range. */
export function ImageSavingsCard({ siteId }: { siteId: string }) {
  const [range, setRange] = React.useState<AnalyticsRange>("24h");
  const savings = useQuery({
    ...orpc.imageConvert.savings.queryOptions({ input: { id: siteId, range } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "200ms" }}
      data-testid="image-savings-card"
    >
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.image_savings_title()}</CardTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="image-savings-range"
            label={m.security_hours()}
            value={range}
            testId="image-savings-range"
            options={ANALYTICS_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
            onChange={(value) => setRange(value as AnalyticsRange)}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={savings}>
          {({ bytesSaved, unsupportedNodes }) => (
            <>
              <p
                className="font-heading text-3xl font-medium tabular-nums"
                data-testid="image-savings-bytes"
              >
                {formatBytes(bytesSaved)}
              </p>
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="image-savings-partial">
                  {m.image_savings_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}
