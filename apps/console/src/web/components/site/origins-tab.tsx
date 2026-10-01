import type {
  ActiveHealthCheck,
  FeatureAvailability,
  OriginHealth,
  OriginSettings,
  Site,
} from "@edgeweir/contract";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import * as React from "react";
import { BorderBeam } from "@/components/appica/effects";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SettingsGroup, SwitchField } from "@/components/site/fields";
import { OriginHealthBadge, OriginHealthError } from "@/components/site/origin-health";
import { nextDraftKey, SaveBar, serializeDrafts, useSaveSite } from "@/components/site/save-site";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { unavailableReason } from "@/lib/protection";
import { cn } from "@/lib/utils";

/** Origins tab: the origin pool and its behaviour, each saved on its own. */
export function OriginsTab({ site }: { site: Site }) {
  return (
    <div className="flex flex-col gap-4">
      {/* Keyed by their own data, so saving one card keeps unsaved edits in the other. */}
      <OriginsCard key={JSON.stringify(site.origins)} site={site} />
      <PoolSettingsCard key={JSON.stringify(site.originSettings)} site={site} />
    </div>
  );
}

type Scheme = "http" | "https";

interface OriginDraft {
  key: number;
  originId: string | null;
  address: string;
  port: string;
  scheme: Scheme;
  weight: string;
  backup: boolean;
  hostHeader: string;
  sni: string;
  s3: boolean;
  region: string;
  bucket: string;
  accessKeyId: string;
  /** Write-only; empty keeps the stored secret of the same access key. */
  secretAccessKey: string;
}

const newOrigin = (): OriginDraft => ({
  key: nextDraftKey(),
  originId: null,
  address: "",
  port: "80",
  scheme: "http",
  weight: "1",
  backup: false,
  hostHeader: "",
  sni: "",
  s3: false,
  region: "",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
});

const SCHEMES = [
  { label: "HTTP", value: "http" },
  { label: "HTTPS", value: "https" },
];

function OriginsCard({ site }: { site: Site }) {
  const initial = React.useMemo(
    () =>
      site.origins.map<OriginDraft>((o) => ({
        key: nextDraftKey(),
        originId: o.id,
        address: o.address,
        port: String(o.port),
        scheme: o.scheme,
        weight: String(o.weight),
        backup: o.backup,
        hostHeader: o.hostHeader,
        sni: o.sni,
        s3: o.s3 !== null,
        region: o.s3?.region ?? "",
        bucket: o.s3?.bucket ?? "",
        accessKeyId: o.s3?.accessKeyId ?? "",
        secretAccessKey: "",
      })),
    [site.origins],
  );
  // Access keys whose secret the server already stores for this site.
  const storedKeys = React.useMemo(
    () => new Set(site.origins.flatMap((o) => (o.s3 ? [o.s3.accessKeyId] : []))),
    [site.origins],
  );
  const [rows, setRows] = React.useState(initial);
  const { save, error, pending } = useSaveSite(site.id);
  const health = useQuery({
    ...orpc.sites.originHealth.queryOptions({ input: { id: site.id } }),
    refetchInterval: 10_000,
    meta: { background: true },
  });
  const healthOf = (originId: string | null) =>
    originId ? health.data?.find((h) => h.originId === originId) : undefined;
  const dirty = serializeDrafts(rows) !== serializeDrafts(initial);
  const patch = (key: number, change: Partial<OriginDraft>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  return (
    <Card data-testid="origins-card">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            origins: rows.map((r) => ({
              address: r.address.trim(),
              port: Number(r.port) || (r.scheme === "https" ? 443 : 80),
              scheme: r.scheme,
              weight: Number(r.weight) || 1,
              backup: r.backup,
              hostHeader: r.hostHeader.trim(),
              sni: r.sni.trim(),
              s3: r.s3
                ? {
                    region: r.region.trim(),
                    bucket: r.bucket.trim(),
                    accessKeyId: r.accessKeyId.trim(),
                    ...(r.secretAccessKey ? { secretAccessKey: r.secretAccessKey } : {}),
                  }
                : null,
            })),
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_tab_origins()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rows.map((row, index) => {
            const rowHealth = healthOf(row.originId);
            const fields = (
              <OriginRow
                row={row}
                index={index}
                health={rowHealth}
                secretStored={storedKeys.has(row.accessKeyId.trim())}
                removable={rows.length > 1}
                onChange={(change) => patch(row.key, change)}
                onRemove={() => setRows(rows.filter((r) => r.key !== row.key))}
              />
            );
            return (
              <div
                key={row.key}
                className="animate-enter"
                style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
              >
                {rowHealth && rowHealth.downNodes > 0 ? (
                  <BorderBeam tone="destructive" speed={6} className="rounded-2xl">
                    {fields}
                  </BorderBeam>
                ) : (
                  fields
                )}
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setRows([...rows, newOrigin()])}
            data-testid="origin-add"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.site_origin_add()}
          </Button>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="origins-save" />
      </form>
    </Card>
  );
}

function OriginRow({
  row,
  index,
  health,
  secretStored,
  removable,
  onChange,
  onRemove,
}: {
  row: OriginDraft;
  index: number;
  health: OriginHealth | undefined;
  secretStored: boolean;
  removable: boolean;
  onChange: (change: Partial<OriginDraft>) => void;
  onRemove: () => void;
}) {
  const id = (name: string) => `origin-${name}-${row.key}`;
  const https = row.scheme === "https";
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 rounded-2xl border p-3"
      aria-label={m.site_origin_number({ index: index + 1 })}
      data-testid="origin-row"
      data-origin-id={row.originId ?? undefined}
    >
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {m.site_origin_number({ index: index + 1 })}
        </span>
        <OriginHealthBadge health={health} />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label={m.common_remove()}
          disabled={!removable}
          onClick={onRemove}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      </div>
      <OriginHealthError health={health} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_6rem_7rem_5rem]">
        <Field className="col-span-2 sm:col-span-1">
          <FieldLabel htmlFor={id("address")}>{m.site_form_origin()}</FieldLabel>
          <Input
            id={id("address")}
            value={row.address}
            required
            maxLength={253}
            onChange={(event) => onChange({ address: event.target.value })}
            placeholder="origin.example.com"
            data-testid="origin-address"
          />
        </Field>
        <NumberField
          id={id("port")}
          label={m.site_form_port()}
          value={row.port}
          min={1}
          max={65535}
          onChange={(port) => onChange({ port })}
          testId="origin-port"
        />
        <Field>
          <FieldLabel>{m.site_form_scheme()}</FieldLabel>
          <Select
            value={row.scheme}
            onValueChange={(v) => v && onChange({ scheme: v as Scheme })}
            items={SCHEMES}
          >
            <SelectTrigger className="w-full" data-testid="origin-scheme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEMES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <NumberField
          id={id("weight")}
          label={m.site_origin_weight()}
          value={row.weight}
          min={1}
          max={100}
          onChange={(weight) => onChange({ weight })}
        />
      </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-3",
          https ? "lg:grid-cols-[1fr_1fr_auto_auto]" : "lg:grid-cols-[1fr_auto_auto]",
        )}
      >
        <Field className={cn("col-span-2", https ? "sm:col-span-1" : "lg:col-span-1")}>
          <FieldLabel htmlFor={id("host")}>{m.site_form_host_header()}</FieldLabel>
          <Input
            id={id("host")}
            value={row.hostHeader}
            maxLength={253}
            onChange={(event) => onChange({ hostHeader: event.target.value })}
            placeholder={m.site_form_host_header_placeholder()}
          />
        </Field>
        {https ? (
          <Field className="col-span-2 sm:col-span-1">
            <FieldLabel htmlFor={id("sni")}>{m.site_origin_sni()}</FieldLabel>
            <Input
              id={id("sni")}
              value={row.sni}
              maxLength={253}
              onChange={(event) => onChange({ sni: event.target.value })}
              placeholder={m.site_origin_sni_placeholder()}
              data-testid="origin-sni"
            />
          </Field>
        ) : null}
        <SwitchField
          id={id("backup")}
          label={m.site_origin_backup()}
          checked={row.backup}
          onCheckedChange={(backup) => onChange({ backup })}
        />
        <SwitchField
          id={id("s3")}
          label={m.site_origin_s3()}
          checked={row.s3}
          onCheckedChange={(s3) => onChange({ s3 })}
          testId="origin-s3"
        />
      </div>
      {row.s3 ? (
        <div
          className="grid gap-3 rounded-xl bg-muted/50 p-3 animate-enter sm:grid-cols-2 lg:grid-cols-4"
          data-testid="origin-s3-fields"
        >
          <Field>
            <FieldLabel htmlFor={id("region")}>{m.site_origin_s3_region()}</FieldLabel>
            <Input
              id={id("region")}
              value={row.region}
              required
              maxLength={64}
              pattern="[A-Za-z0-9][A-Za-z0-9\-]*"
              onChange={(event) => onChange({ region: event.target.value })}
              placeholder="us-east-1"
              data-testid="origin-s3-region"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("bucket")}>{m.site_origin_s3_bucket()}</FieldLabel>
            <Input
              id={id("bucket")}
              value={row.bucket}
              maxLength={63}
              onChange={(event) => onChange({ bucket: event.target.value })}
              placeholder={m.site_origin_s3_bucket_placeholder()}
              data-testid="origin-s3-bucket"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("access-key")}>{m.site_origin_s3_access_key()}</FieldLabel>
            <Input
              id={id("access-key")}
              value={row.accessKeyId}
              required
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onChange({ accessKeyId: event.target.value })}
              className="font-mono"
              data-testid="origin-s3-access-key"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={id("secret")}>{m.site_origin_s3_secret()}</FieldLabel>
            <Input
              id={id("secret")}
              type="password"
              value={row.secretAccessKey}
              required={!secretStored}
              maxLength={256}
              autoComplete="new-password"
              onChange={(event) => onChange({ secretAccessKey: event.target.value })}
              placeholder={secretStored ? m.site_origin_s3_secret_stored() : undefined}
              data-testid="origin-s3-secret"
            />
          </Field>
        </div>
      ) : null}
    </fieldset>
  );
}

type PolicyValue = OriginSettings["policy"];
type HealthMethod = ActiveHealthCheck["method"];

interface PoolDraft {
  policy: PolicyValue;
  tlsVerify: boolean;
  maxFails: string;
  recoverySeconds: string;
  connectTimeout: string;
  sendTimeout: string;
  readTimeout: string;
  keepalive: boolean;
  keepaliveIdleSeconds: string;
  keepaliveMaxRequests: string;
  websocket: boolean;
  /** Active health check; its values are kept (and editable) while it is off. */
  healthEnabled: boolean;
  healthPath: string;
  healthMethod: HealthMethod;
  healthStatusMin: string;
  healthStatusMax: string;
  healthHost: string;
  healthInterval: string;
  healthTimeout: string;
  healthHealthy: string;
  healthUnhealthy: string;
  affinityEnabled: boolean;
  affinityTtl: string;
}

/** Timeouts are stored in milliseconds and edited in seconds, like every other duration here. */
const msToSeconds = (ms: number) => String(ms / 1000);
const secondsToMs = (value: string, fallback: number) => {
  const seconds = Number(value);
  return value.trim() && Number.isFinite(seconds) ? Math.round(seconds * 1000) : fallback;
};
const toInt = (value: string, fallback: number) => {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? Math.round(n) : fallback;
};

const HEALTH_METHODS = [
  { label: "GET", value: "GET" },
  { label: "HEAD", value: "HEAD" },
] satisfies { label: string; value: HealthMethod }[];

/**
 * Whether a tenant may turn a pool feature on: not while the cluster's nodes lack it (the
 * server refuses). Administrators may require it anyway, and a feature that is on can go off.
 */
const lockedFor = (
  availability: FeatureAvailability | undefined,
  admin: boolean,
  savedOn: boolean,
) => !admin && !savedOn && availability?.available === false;

function PoolSettingsCard({ site }: { site: Site }) {
  const { isAdmin } = useRouteContext({ from: "/_app" });
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  const s = site.originSettings;
  const health = s.activeHealthCheck;
  const initial = React.useMemo<PoolDraft>(
    () => ({
      policy: s.policy,
      tlsVerify: s.tlsVerify,
      maxFails: String(s.maxFails),
      recoverySeconds: String(s.recoverySeconds),
      connectTimeout: msToSeconds(s.connectTimeoutMs),
      sendTimeout: msToSeconds(s.sendTimeoutMs),
      readTimeout: msToSeconds(s.readTimeoutMs),
      keepalive: s.keepalive,
      keepaliveIdleSeconds: String(s.keepaliveIdleSeconds),
      keepaliveMaxRequests: String(s.keepaliveMaxRequests),
      websocket: s.websocket,
      healthEnabled: s.activeHealthCheck.enabled,
      healthPath: s.activeHealthCheck.path,
      healthMethod: s.activeHealthCheck.method,
      healthStatusMin: String(s.activeHealthCheck.expectedStatusMin),
      healthStatusMax: String(s.activeHealthCheck.expectedStatusMax),
      healthHost: s.activeHealthCheck.host,
      healthInterval: String(s.activeHealthCheck.intervalSeconds),
      healthTimeout: String(s.activeHealthCheck.timeoutSeconds),
      healthHealthy: String(s.activeHealthCheck.healthyThreshold),
      healthUnhealthy: String(s.activeHealthCheck.unhealthyThreshold),
      affinityEnabled: s.sessionAffinity.enabled,
      affinityTtl: String(s.sessionAffinity.ttlSeconds),
    }),
    [s],
  );
  const [draft, setDraft] = React.useState(initial);
  const { save, error, pending } = useSaveSite(site.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (change: Partial<PoolDraft>) => setDraft({ ...draft, ...change });
  const policies: { label: string; value: PolicyValue }[] = [
    { label: m.site_pool_policy_weighted_random(), value: "weighted_random" },
    { label: m.site_pool_policy_round_robin(), value: "round_robin" },
    { label: m.site_pool_policy_consistent_hash(), value: "consistent_hash" },
  ];
  const healthAvailability = features.data?.activeHealthCheck;
  const affinityAvailability = features.data?.sessionAffinity;
  const interval = toInt(draft.healthInterval, health.intervalSeconds);

  return (
    <Card className="animate-enter" style={{ animationDelay: "80ms" }} data-testid="pool-settings">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            // Every pool setting is sent: the update replaces them.
            originSettings: {
              ...s,
              policy: draft.policy,
              tlsVerify: draft.tlsVerify,
              maxFails: toInt(draft.maxFails, s.maxFails),
              recoverySeconds: toInt(draft.recoverySeconds, s.recoverySeconds),
              connectTimeoutMs: secondsToMs(draft.connectTimeout, s.connectTimeoutMs),
              sendTimeoutMs: secondsToMs(draft.sendTimeout, s.sendTimeoutMs),
              readTimeoutMs: secondsToMs(draft.readTimeout, s.readTimeoutMs),
              keepalive: draft.keepalive,
              keepaliveIdleSeconds: toInt(draft.keepaliveIdleSeconds, s.keepaliveIdleSeconds),
              keepaliveMaxRequests: toInt(draft.keepaliveMaxRequests, s.keepaliveMaxRequests),
              websocket: draft.websocket,
              activeHealthCheck: {
                enabled: draft.healthEnabled,
                path: draft.healthPath.trim(),
                method: draft.healthMethod,
                expectedStatusMin: toInt(draft.healthStatusMin, health.expectedStatusMin),
                expectedStatusMax: toInt(draft.healthStatusMax, health.expectedStatusMax),
                host: draft.healthHost.trim(),
                intervalSeconds: interval,
                timeoutSeconds: toInt(draft.healthTimeout, health.timeoutSeconds),
                healthyThreshold: toInt(draft.healthHealthy, health.healthyThreshold),
                unhealthyThreshold: toInt(draft.healthUnhealthy, health.unhealthyThreshold),
              },
              sessionAffinity: {
                enabled: draft.affinityEnabled,
                ttlSeconds: toInt(draft.affinityTtl, s.sessionAffinity.ttlSeconds),
              },
            },
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_pool_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field>
              <FieldLabel>{m.site_pool_policy()}</FieldLabel>
              <Select
                value={draft.policy}
                onValueChange={(v) => v && set({ policy: v as PolicyValue })}
                items={policies}
              >
                <SelectTrigger className="w-full" data-testid="pool-policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {policies.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {/* The switches wrap onto two lines where their labels do not fit side by side. */}
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3 lg:col-span-2">
              <SwitchField
                id="pool-tls-verify"
                label={m.site_pool_tls_verify()}
                checked={draft.tlsVerify}
                onCheckedChange={(tlsVerify) => set({ tlsVerify })}
                testId="pool-tls-verify"
              />
              <SwitchField
                id="pool-websocket"
                label={m.site_pool_websocket()}
                checked={draft.websocket}
                onCheckedChange={(websocket) => set({ websocket })}
                testId="pool-websocket"
              />
            </div>
          </div>
          <div className="flex flex-col gap-2" data-testid="origins-affinity-group">
            <SettingsGroup legend={m.site_pool_affinity()}>
              <SwitchField
                id="origins-affinity"
                label={m.site_pool_affinity_enabled()}
                checked={draft.affinityEnabled}
                disabled={lockedFor(affinityAvailability, isAdmin, s.sessionAffinity.enabled)}
                onCheckedChange={(affinityEnabled) => set({ affinityEnabled })}
                testId="origins-affinity"
              />
              <NumberField
                id="origins-affinity-ttl"
                label={m.site_pool_affinity_ttl()}
                value={draft.affinityTtl}
                min={60}
                max={604800}
                step={1}
                required
                onChange={(affinityTtl) => set({ affinityTtl })}
                testId="origins-affinity-ttl"
              />
            </SettingsGroup>
            <Unavailable
              availability={affinityAvailability}
              testId="origins-affinity-unavailable"
            />
          </div>
          <SettingsGroup legend={m.site_pool_health()}>
            <NumberField
              id="pool-max-fails"
              label={m.site_pool_max_fails()}
              value={draft.maxFails}
              min={1}
              max={100}
              required
              onChange={(maxFails) => set({ maxFails })}
              testId="pool-max-fails"
            />
            <NumberField
              id="pool-recovery"
              label={m.site_pool_recovery()}
              value={draft.recoverySeconds}
              min={1}
              max={3600}
              required
              onChange={(recoverySeconds) => set({ recoverySeconds })}
            />
          </SettingsGroup>
          <div className="flex flex-col gap-2" data-testid="origins-active-health-group">
            {/* Two columns on phones, four from lg: path and Host take two each. */}
            <SettingsGroup legend={m.site_pool_active_health()} className="lg:grid-cols-4">
              <SwitchField
                id="origins-active-health"
                label={m.site_pool_active_health_enabled()}
                checked={draft.healthEnabled}
                disabled={lockedFor(healthAvailability, isAdmin, health.enabled)}
                onCheckedChange={(healthEnabled) => set({ healthEnabled })}
                testId="origins-active-health"
              />
              <Field>
                <FieldLabel htmlFor="origins-health-method">
                  {m.site_pool_health_method()}
                </FieldLabel>
                <Select
                  value={draft.healthMethod}
                  onValueChange={(v) => v && set({ healthMethod: v as HealthMethod })}
                  items={HEALTH_METHODS}
                >
                  <SelectTrigger
                    id="origins-health-method"
                    className="w-full"
                    data-testid="origins-health-method"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HEALTH_METHODS.map((method) => (
                      <SelectItem key={method.value} value={method.value}>
                        {method.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field className="col-span-2">
                <FieldLabel htmlFor="origins-health-path">{m.site_pool_health_path()}</FieldLabel>
                <Input
                  id="origins-health-path"
                  value={draft.healthPath}
                  required
                  maxLength={1024}
                  // An absolute path with an optional query: printable ASCII without spaces.
                  pattern="/[!-~]*"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => set({ healthPath: event.target.value })}
                  placeholder="/healthz"
                  className="font-mono"
                  data-testid="origins-health-path"
                />
              </Field>
              <Field className="col-span-2">
                <FieldLabel htmlFor="origins-health-host">{m.site_pool_health_host()}</FieldLabel>
                <Input
                  id="origins-health-host"
                  value={draft.healthHost}
                  maxLength={253}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => set({ healthHost: event.target.value })}
                  placeholder={m.site_pool_health_host_placeholder()}
                  data-testid="origins-health-host"
                />
              </Field>
              <NumberField
                id="origins-health-status-min"
                label={m.site_pool_health_status_min()}
                value={draft.healthStatusMin}
                min={100}
                max={599}
                step={1}
                required
                onChange={(healthStatusMin) => set({ healthStatusMin })}
                testId="origins-health-status-min"
              />
              <NumberField
                id="origins-health-status-max"
                label={m.site_pool_health_status_max()}
                value={draft.healthStatusMax}
                min={toInt(draft.healthStatusMin, 100)}
                max={599}
                step={1}
                required
                onChange={(healthStatusMax) => set({ healthStatusMax })}
                testId="origins-health-status-max"
              />
              <NumberField
                id="origins-health-interval"
                label={m.site_pool_health_interval()}
                value={draft.healthInterval}
                min={5}
                max={300}
                step={1}
                required
                onChange={(healthInterval) => set({ healthInterval })}
                testId="origins-health-interval"
              />
              <NumberField
                id="origins-health-timeout"
                label={m.site_pool_health_timeout()}
                value={draft.healthTimeout}
                min={1}
                max={Math.max(1, Math.min(60, interval))}
                step={1}
                required
                onChange={(healthTimeout) => set({ healthTimeout })}
                testId="origins-health-timeout"
              />
              <NumberField
                id="origins-health-healthy"
                label={m.site_pool_health_healthy()}
                value={draft.healthHealthy}
                min={1}
                max={10}
                step={1}
                required
                onChange={(healthHealthy) => set({ healthHealthy })}
                testId="origins-health-healthy"
              />
              <NumberField
                id="origins-health-unhealthy"
                label={m.site_pool_health_unhealthy()}
                value={draft.healthUnhealthy}
                min={1}
                max={10}
                step={1}
                required
                onChange={(healthUnhealthy) => set({ healthUnhealthy })}
                testId="origins-health-unhealthy"
              />
            </SettingsGroup>
            <Unavailable
              availability={healthAvailability}
              testId="origins-active-health-unavailable"
            />
          </div>
          <SettingsGroup legend={m.site_pool_timeouts()}>
            <NumberField
              id="pool-connect-timeout"
              label={m.site_pool_connect_timeout()}
              value={draft.connectTimeout}
              min={0.1}
              max={120}
              step="any"
              required
              onChange={(connectTimeout) => set({ connectTimeout })}
              testId="pool-connect-timeout"
            />
            <NumberField
              id="pool-send-timeout"
              label={m.site_pool_send_timeout()}
              value={draft.sendTimeout}
              min={0.1}
              max={3600}
              step="any"
              required
              onChange={(sendTimeout) => set({ sendTimeout })}
            />
            <NumberField
              id="pool-read-timeout"
              label={m.site_pool_read_timeout()}
              value={draft.readTimeout}
              min={0.1}
              max={3600}
              step="any"
              required
              onChange={(readTimeout) => set({ readTimeout })}
            />
          </SettingsGroup>
          <SettingsGroup legend={m.site_pool_keepalive()}>
            <SwitchField
              id="pool-keepalive"
              label={m.site_pool_keepalive_enabled()}
              checked={draft.keepalive}
              onCheckedChange={(keepalive) => set({ keepalive })}
              testId="pool-keepalive"
            />
            <NumberField
              id="pool-keepalive-idle"
              label={m.site_pool_keepalive_idle()}
              value={draft.keepaliveIdleSeconds}
              min={1}
              max={3600}
              required
              disabled={!draft.keepalive}
              onChange={(keepaliveIdleSeconds) => set({ keepaliveIdleSeconds })}
            />
            <NumberField
              id="pool-keepalive-requests"
              label={m.site_pool_keepalive_requests()}
              value={draft.keepaliveMaxRequests}
              min={1}
              max={100000}
              required
              disabled={!draft.keepalive}
              onChange={(keepaliveMaxRequests) => set({ keepaliveMaxRequests })}
            />
          </SettingsGroup>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="pool-save" />
      </form>
    </Card>
  );
}

/** One line on why the cluster cannot use a pool feature yet. */
function Unavailable({
  availability,
  testId,
}: {
  availability: FeatureAvailability | undefined;
  testId: string;
}) {
  if (!availability || availability.available) return null;
  return (
    <SafetyNote
      className="animate-in fade-in"
      data-testid={testId}
      data-reason={availability.reason ?? undefined}
    >
      {unavailableReason(availability)}
    </SafetyNote>
  );
}
