import { CORS_MAX_AGE, type CorsSettings } from "@edgeweir/contract";
import { FormSelect } from "@/components/form-select";
import { ListText } from "@/components/site/access-control/fields";
import { AccessPartCard } from "@/components/site/access-control/part-card";
import { ListInput, NumberField, SwitchField } from "@/components/site/fields";
import { Field, FieldLabel } from "@/components/ui/field";
import { m } from "@/lib/i18n";

type Draft = Omit<CorsSettings, "maxAgeSeconds"> & { maxAgeSeconds: string };

/**
 * CORS at the edge: preflights answered by the node (204, or 403 for an origin that is not
 * allowed) unless they go to the origin, and the CORS headers of every response in scope,
 * cache hits included. Off, only the switch shows.
 */
export function CorsCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="cors"
      title={m.access_cors_title()}
      testId="cors"
      index={index}
      toDraft={(value): Draft => ({ ...value, maxAgeSeconds: String(value.maxAgeSeconds) })}
      toPart={(draft) => ({
        ...draft,
        maxAgeSeconds: draft.maxAgeSeconds.trim() === "" ? Number.NaN : Number(draft.maxAgeSeconds),
      })}
      inUse={(value) => value.enabled}
      labels={{
        allowedOrigins: m.access_cors_origins,
        allowedMethods: m.access_cors_methods,
        allowedHeaders: m.access_cors_headers,
        exposedHeaders: m.access_cors_exposed,
        maxAgeSeconds: m.access_cors_max_age,
        pathPrefixes: m.access_path_prefixes,
      }}
      // The API refuses "*" with credentials (CORS_CREDENTIALS_WILDCARD); say so before saving.
      check={(value) =>
        value.allowCredentials && value.allowedOrigins.includes("*")
          ? { message: m.error_cors_credentials_wildcard(), field: "allowedOrigins" }
          : null
      }
    >
      {({ draft, set, blocked, invalid }) => (
        <>
          <SwitchField
            id="cors-enabled"
            label={m.access_enabled()}
            checked={draft.enabled}
            disabled={blocked}
            onCheckedChange={(enabled) => set({ enabled })}
            className="self-start"
            testId="cors-enabled"
          />
          {draft.enabled ? (
            <div className="flex flex-col gap-5 animate-in fade-in">
              <div className="grid gap-4 sm:grid-cols-2">
                <ListText
                  id="cors-origins"
                  label={m.access_cors_origins()}
                  value={draft.allowedOrigins}
                  placeholder={"https://app.example.com\n*"}
                  invalid={invalid("allowedOrigins")}
                  onChange={(allowedOrigins) => set({ allowedOrigins })}
                  testId="cors-origins"
                />
                <ListText
                  id="cors-prefixes"
                  label={m.access_path_prefixes()}
                  value={draft.pathPrefixes}
                  placeholder="/api/"
                  invalid={invalid("pathPrefixes")}
                  onChange={(pathPrefixes) => set({ pathPrefixes })}
                  testId="cors-prefixes"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Field data-invalid={invalid("allowedMethods") || undefined}>
                  <FieldLabel htmlFor="cors-methods">{m.access_cors_methods()}</FieldLabel>
                  <ListInput
                    id="cors-methods"
                    value={draft.allowedMethods}
                    invalid={invalid("allowedMethods")}
                    onChange={(allowedMethods) => set({ allowedMethods })}
                    testId="cors-methods"
                  />
                </Field>
                <NumberField
                  id="cors-max-age"
                  label={m.access_cors_max_age()}
                  value={draft.maxAgeSeconds}
                  min={CORS_MAX_AGE.min}
                  max={CORS_MAX_AGE.max}
                  step={1}
                  invalid={invalid("maxAgeSeconds")}
                  onChange={(maxAgeSeconds) => set({ maxAgeSeconds })}
                  testId="cors-max-age"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <FormSelect
                  id="cors-headers-mode"
                  label={m.access_cors_headers()}
                  value={draft.echoRequestHeaders ? "echo" : "list"}
                  options={[
                    { value: "list", label: m.access_cors_headers_list() },
                    { value: "echo", label: m.access_cors_headers_echo() },
                  ]}
                  onChange={(mode) => set({ echoRequestHeaders: mode === "echo" })}
                  testId="cors-headers-mode"
                />
                {draft.echoRequestHeaders ? null : (
                  <Field data-invalid={invalid("allowedHeaders") || undefined}>
                    <FieldLabel htmlFor="cors-headers">{m.access_cors_headers_names()}</FieldLabel>
                    <ListInput
                      id="cors-headers"
                      value={draft.allowedHeaders}
                      placeholder="content-type, authorization"
                      invalid={invalid("allowedHeaders")}
                      onChange={(allowedHeaders) => set({ allowedHeaders })}
                      testId="cors-headers"
                    />
                  </Field>
                )}
              </div>
              <Field data-invalid={invalid("exposedHeaders") || undefined}>
                <FieldLabel htmlFor="cors-exposed">{m.access_cors_exposed()}</FieldLabel>
                <ListInput
                  id="cors-exposed"
                  value={draft.exposedHeaders}
                  placeholder="x-request-id"
                  invalid={invalid("exposedHeaders")}
                  onChange={(exposedHeaders) => set({ exposedHeaders })}
                  testId="cors-exposed"
                />
              </Field>
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <SwitchField
                  id="cors-credentials"
                  label={m.access_cors_credentials()}
                  checked={draft.allowCredentials}
                  onCheckedChange={(allowCredentials) => set({ allowCredentials })}
                  testId="cors-credentials"
                />
                <SwitchField
                  id="cors-preflight-origin"
                  label={m.access_cors_preflight_origin()}
                  checked={draft.preflightToOrigin}
                  onCheckedChange={(preflightToOrigin) => set({ preflightToOrigin })}
                  testId="cors-preflight-origin"
                />
                <SwitchField
                  id="cors-keep-origin"
                  label={m.access_cors_keep_origin()}
                  checked={draft.keepOriginHeaders}
                  onCheckedChange={(keepOriginHeaders) => set({ keepOriginHeaders })}
                  testId="cors-keep-origin"
                />
              </div>
            </div>
          ) : null}
        </>
      )}
    </AccessPartCard>
  );
}
