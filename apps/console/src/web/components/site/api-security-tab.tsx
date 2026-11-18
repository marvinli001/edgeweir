import type { ApiSecuritySettings, ApiSecurityState, Site } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/arc/select/select";
import { Textarea } from "@/components/arc/textarea/textarea";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { ApiExceptions } from "@/components/site/api-security-exceptions";
import {
  ApiImportDialog,
  ApiImportIssues,
  ApiSchemaEndpoints,
} from "@/components/site/api-security-import";
import { ApiSecurityResults } from "@/components/site/api-security-results";
import { AuthScopeFields } from "@/components/site/auth-scope-fields";
import { NumberField, SwitchField } from "@/components/site/fields";
import { CheckboxList } from "@/components/site/ports-card";
import { SaveBar } from "@/components/site/save-site";
import { QueryView } from "@/components/states";
import { useDraft } from "@/hooks/use-draft";
import { apiSecurityDraft, parseApiSecurityDraft } from "@/lib/api-security";
import { apiCheckLabel, apiFieldLabel, apiModeLabel } from "@/lib/api-security-labels";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

type Check = ApiSecuritySettings["exceptions"][number]["check"];
type Mode = ApiSecuritySettings["schema"]["mode"];

export function ApiSecurityTab({ site }: { site: Site }) {
  const settings = useQuery(orpc.apiSecurity.get.queryOptions({ input: { id: site.id } }));
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="api-security-tab">
      <Panel>
        <PanelHeader>
          <PanelTitle>{m.site_tab_api_security()}</PanelTitle>
        </PanelHeader>
        <QueryView query={settings} frame={PanelContent}>
          {(server) => <ApiSecurityForm site={site} server={server} />}
        </QueryView>
      </Panel>
      <ApiSecurityResults siteId={site.id} />
    </div>
  );
}

function ApiSecurityForm({ site, server }: { site: Site; server: ApiSecurityState }) {
  const queryClient = useQueryClient();
  const { draft, setDraft, dirty, markSaved, version } = useDraft(
    apiSecurityDraft(server.settings),
    server.updatedAt,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [enforcing, setEnforcing] = React.useState<ApiSecuritySettings | null>(null);
  const update = useMutation({
    ...orpc.apiSecurity.update.mutationOptions(),
    meta: { invalidates: [orpc.apiSecurity.key(), orpc.sites.key()], success: m.common_saved },
  });
  const blocked = server.unsupportedNodes > 0;
  const set = (next: typeof draft) => {
    setDraft(next);
    setError(null);
  };
  const save = async (settings: ApiSecuritySettings) => {
    const saved = await update.mutateAsync({ id: site.id, settings, expectedUpdatedAt: version });
    queryClient.setQueryData(orpc.apiSecurity.get.queryKey({ input: { id: site.id } }), saved);
    markSaved();
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = parseApiSecurityDraft(draft);
    if (!parsed.success) {
      setError(
        parsed.code === "privateKey"
          ? m.api_security_private_key_rejected()
          : parsed.code === "jwks"
            ? m.api_security_jwks_invalid()
            : parsed.code === "schemaIssues"
              ? m.api_security_issues_prevent_enforce()
              : m.common_check_field({ field: apiFieldLabel(parsed.field) }),
      );
      return;
    }
    if (
      (["schema", "jwt", "graphql"] as const).some(
        (check) =>
          parsed.settings[check].mode === "enforce" && server.settings[check].mode !== "enforce",
      )
    ) {
      setEnforcing(parsed.settings);
      return;
    }
    try {
      await save(parsed.settings);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
        <PanelContent>
          <fieldset disabled={update.isPending} className="flex min-w-0 flex-col gap-6">
            {blocked ? (
              <SafetyNote data-testid="api-security-unsupported">
                {m.api_security_unsupported_nodes({ count: formatNumber(server.unsupportedNodes) })}
              </SafetyNote>
            ) : null}
            <div className="text-xs text-muted-foreground" data-testid="api-security-updated-at">
              {m.api_security_updated_at({ time: formatDateTime(server.updatedAt) })}
            </div>
            <FieldSet className="gap-4">
              <FieldLegend>{m.api_security_discovery()}</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-2">
                <SwitchField
                  id="api-discovery-enabled"
                  label={m.api_security_discovery_enabled()}
                  checked={draft.discovery.enabled}
                  disabled={blocked && !draft.discovery.enabled}
                  testId="api-discovery-enabled"
                  onCheckedChange={(enabled) =>
                    set({ ...draft, discovery: { ...draft.discovery, enabled } })
                  }
                />
                <NumberField
                  id="api-discovery-rate"
                  label={m.api_security_sample_rate()}
                  value={draft.discovery.sampleRate}
                  min={1}
                  max={10000}
                  step={1}
                  required
                  testId="api-discovery-rate"
                  onChange={(sampleRate) =>
                    set({ ...draft, discovery: { ...draft.discovery, sampleRate } })
                  }
                />
              </div>
            </FieldSet>
            <FieldSet className="gap-4 border-t pt-5" data-testid="api-schema-settings">
              <FieldLegend>{m.api_security_schema()}</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-2">
                <ApiModeField
                  check="schema"
                  value={draft.schema.mode}
                  blocked={blocked}
                  issues={draft.schema.issues.length > 0}
                  onChange={(mode) => set({ ...draft, schema: { ...draft.schema, mode } })}
                />
                <FormSelect
                  id="api-schema-unknown"
                  label={m.api_security_unknown_endpoints()}
                  value={draft.schema.unknownEndpoints}
                  testId="api-schema-unknown"
                  options={[
                    { value: "allow", label: m.api_security_unknown_allow() },
                    { value: "block", label: m.api_security_unknown_block() },
                  ]}
                  onChange={(unknownEndpoints) =>
                    set({ ...draft, schema: { ...draft.schema, unknownEndpoints } })
                  }
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm">
                  {m.api_security_schema_count({
                    count: formatNumber(draft.schema.endpoints.length),
                  })}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => setImporting(true)}
                  data-testid="api-import-open"
                >
                  {m.api_security_import()}
                </Button>
              </div>
              <ApiImportIssues issues={draft.schema.issues} />
              <ApiSchemaEndpoints endpoints={draft.schema.endpoints} />
            </FieldSet>
            <FieldSet className="gap-4 border-t pt-5" data-testid="api-jwt-settings">
              <FieldLegend>{m.api_security_jwt()}</FieldLegend>
              <ApiModeField
                check="jwt"
                value={draft.jwt.mode}
                blocked={blocked}
                onChange={(mode) => set({ ...draft, jwt: { ...draft.jwt, mode } })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="api-jwt-issuer">{m.api_security_issuer()}</FieldLabel>
                  <Input
                    id="api-jwt-issuer"
                    value={draft.jwt.issuer}
                    maxLength={512}
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) =>
                      set({ ...draft, jwt: { ...draft.jwt, issuer: event.target.value } })
                    }
                    data-testid="api-jwt-issuer"
                  />
                </Field>
                <NumberField
                  id="api-jwt-tolerance"
                  label={m.api_security_clock_tolerance()}
                  value={draft.jwt.clockToleranceSeconds}
                  min={0}
                  max={120}
                  step={1}
                  required
                  testId="api-jwt-tolerance"
                  onChange={(clockToleranceSeconds) =>
                    set({ ...draft, jwt: { ...draft.jwt, clockToleranceSeconds } })
                  }
                />
              </div>
              <Field>
                <FieldLabel htmlFor="api-jwt-audiences">{m.api_security_audiences()}</FieldLabel>
                <Textarea
                  id="api-jwt-audiences"
                  rows={2}
                  value={draft.jwt.audiences}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) =>
                    set({ ...draft, jwt: { ...draft.jwt, audiences: event.target.value } })
                  }
                  data-testid="api-jwt-audiences"
                />
              </Field>
              <CheckboxList
                id="api-jwt-algorithms"
                legend={m.api_security_algorithms()}
                value={draft.jwt.algorithms}
                options={(["RS256", "ES256", "EdDSA"] as const).map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(algorithms) => set({ ...draft, jwt: { ...draft.jwt, algorithms } })}
                testId="api-jwt-algorithms"
              />
              <Field>
                <FieldLabel htmlFor="api-jwt-jwks">{m.api_security_jwks()}</FieldLabel>
                <Textarea
                  id="api-jwt-jwks"
                  rows={8}
                  value={draft.jwt.jwks}
                  spellCheck={false}
                  className="font-mono text-xs"
                  wrap="off"
                  onChange={(event) =>
                    set({ ...draft, jwt: { ...draft.jwt, jwks: event.target.value } })
                  }
                  data-testid="api-jwt-jwks"
                />
              </Field>
              <AuthScopeFields
                domains={site.domains}
                value={draft.jwt.scope}
                idPrefix="api-jwt"
                onChange={(change) =>
                  set({ ...draft, jwt: { ...draft.jwt, scope: { ...draft.jwt.scope, ...change } } })
                }
              />
            </FieldSet>
            <FieldSet className="gap-4 border-t pt-5" data-testid="api-graphql-settings">
              <FieldLegend>{m.api_security_graphql()}</FieldLegend>
              <ApiModeField
                check="graphql"
                value={draft.graphql.mode}
                blocked={blocked}
                onChange={(mode) => set({ ...draft, graphql: { ...draft.graphql, mode } })}
              />
              <Field>
                <FieldLabel htmlFor="api-graphql-paths">
                  {m.api_security_graphql_paths()}
                </FieldLabel>
                <Textarea
                  id="api-graphql-paths"
                  rows={2}
                  value={draft.graphql.pathPrefixes}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) =>
                    set({
                      ...draft,
                      graphql: { ...draft.graphql, pathPrefixes: event.target.value },
                    })
                  }
                  data-testid="api-graphql-paths"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {(
                  [
                    ["maxDepth", m.api_security_max_depth(), 1, 30],
                    ["maxFields", m.api_security_max_fields(), 1, 1000],
                    ["maxAliases", m.api_security_max_aliases(), 0, 200],
                    ["maxBatch", m.api_security_max_batch(), 1, 20],
                    ["maxDocumentBytes", m.api_security_max_document_bytes(), 256, 65536],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <NumberField
                    key={key}
                    id={`api-graphql-${key}`}
                    label={label}
                    value={draft.graphql[key]}
                    min={min}
                    max={max}
                    step={1}
                    required
                    testId={`api-graphql-${key}`}
                    onChange={(value) =>
                      set({ ...draft, graphql: { ...draft.graphql, [key]: value } })
                    }
                  />
                ))}
                <SwitchField
                  id="api-graphql-introspection"
                  label={m.api_security_introspection()}
                  checked={draft.graphql.introspection}
                  testId="api-graphql-introspection"
                  onCheckedChange={(introspection) =>
                    set({ ...draft, graphql: { ...draft.graphql, introspection } })
                  }
                />
              </div>
            </FieldSet>
            <ApiExceptions
              value={draft.exceptions}
              onChange={(exceptions) => set({ ...draft, exceptions })}
            />
          </fieldset>
        </PanelContent>
        <SaveBar
          dirty={dirty}
          pending={update.isPending}
          error={error}
          testId="api-security-save"
          errorTestId="api-security-save-error"
          sticky
        />
      </form>
      {importing ? (
        <ApiImportDialog
          siteId={site.id}
          onClose={() => setImporting(false)}
          onApply={(preview) => {
            set({
              ...draft,
              schema: { ...draft.schema, endpoints: preview.endpoints, issues: preview.issues },
            });
            setImporting(false);
          }}
        />
      ) : null}
      <ControlledConfirmDialog
        open={enforcing !== null}
        onOpenChange={(open) => {
          if (!open) setEnforcing(null);
        }}
        title={m.api_security_enforce_title()}
        confirmLabel={m.api_security_save_enforce()}
        destructive={false}
        onConfirm={async () => {
          if (enforcing) await save(enforcing);
        }}
      >
        <ul className="flex flex-col gap-2 text-sm">
          {(["schema", "jwt", "graphql"] as const)
            .filter(
              (check) =>
                enforcing?.[check].mode === "enforce" && server.settings[check].mode !== "enforce",
            )
            .map((check) => (
              <li key={check}>{apiCheckLabel(check)}</li>
            ))}
        </ul>
      </ControlledConfirmDialog>
    </>
  );
}

function ApiModeField({
  check,
  value,
  blocked,
  issues = false,
  onChange,
}: {
  check: Check;
  value: Mode;
  blocked: boolean;
  issues?: boolean;
  onChange: (mode: Mode) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={`api-${check}-mode`}>{m.api_security_mode()}</FieldLabel>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next as Mode);
        }}
      >
        <SelectTrigger
          id={`api-${check}-mode`}
          className="w-full"
          data-testid={`api-${check}-mode`}
        >
          <SelectValue>{apiModeLabel(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(["off", "observe", "enforce"] as const).map((mode) => (
            <SelectItem
              key={mode}
              value={mode}
              disabled={
                (mode !== "off" && blocked && mode !== value) || (mode === "enforce" && issues)
              }
            >
              {apiModeLabel(mode)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
