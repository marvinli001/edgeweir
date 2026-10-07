import {
  certificateUnloadable,
  L4_APP_DEFAULTS,
  type L4App,
  type L4Protocol,
  MAX_L4_APP_LISTS,
  MAX_L4_ORIGINS,
  MAX_L4_RANGE_PORTS,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { L4NodesWarning } from "@/components/l4/common";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SettingsGroup, SwitchField } from "@/components/site/fields";
import { nextDraftKey } from "@/components/site/save-site";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/lib/i18n";
import {
  apiError,
  L4_PROTOCOLS,
  listChips,
  PROXY_VERSIONS,
  poolCovers,
  poolLabel,
  protocolLabel,
  proxyVersionLabel,
} from "@/lib/l4";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** The certificate select's value for plain TCP. */
const NO_TLS = "none";

interface OriginDraft {
  key: number;
  address: string;
  port: string;
  weight: string;
  backup: boolean;
}

interface AppDraft {
  clusterId: string;
  name: string;
  protocol: L4Protocol;
  port: string;
  /** The last port of a range; empty: a single port. */
  portEnd: string;
  originPortMode: "fixed" | "same";
  /** A certificate id, or NO_TLS. */
  certificateId: string;
  tlsMinimumVersion: "1.2" | "1.3";
  enabled: boolean;
  acceptProxyProtocol: boolean;
  proxyProtocolVersion: number;
  origins: OriginDraft[];
  maxFails: string;
  failTimeoutSeconds: string;
  /** Edited in seconds like every other duration; stored in milliseconds. */
  connectTimeout: string;
  idleTimeoutSeconds: string;
  allowListIds: string[];
  blockListIds: string[];
  maxConnections: string;
  newConnectionsPerSecond: string;
}

const newOrigin = (): OriginDraft => ({
  key: nextDraftKey(),
  address: "",
  port: "",
  weight: "1",
  backup: false,
});

function draftOf(app: L4App | undefined, clusterId: string): AppDraft {
  if (!app)
    return {
      clusterId,
      name: "",
      protocol: "tcp",
      port: "",
      portEnd: "",
      originPortMode: "fixed",
      certificateId: NO_TLS,
      tlsMinimumVersion: "1.2",
      enabled: true,
      acceptProxyProtocol: false,
      proxyProtocolVersion: 0,
      origins: [newOrigin()],
      maxFails: String(L4_APP_DEFAULTS.maxFails),
      failTimeoutSeconds: String(L4_APP_DEFAULTS.failTimeoutSeconds),
      connectTimeout: String(L4_APP_DEFAULTS.connectTimeoutMs / 1000),
      idleTimeoutSeconds: String(L4_APP_DEFAULTS.idleTimeoutSeconds.tcp),
      allowListIds: [],
      blockListIds: [],
      maxConnections: "0",
      newConnectionsPerSecond: "0",
    };
  return {
    clusterId: app.clusterId,
    name: app.name,
    protocol: app.protocol,
    port: String(app.port),
    portEnd: app.portEnd ? String(app.portEnd) : "",
    originPortMode: app.originPortMode,
    certificateId: app.certificateId ?? NO_TLS,
    tlsMinimumVersion: app.tlsMinimumVersion,
    enabled: app.enabled,
    acceptProxyProtocol: app.acceptProxyProtocol,
    proxyProtocolVersion: app.proxyProtocolVersion,
    origins: app.origins.map((o) => ({
      key: nextDraftKey(),
      address: o.address,
      port: o.port ? String(o.port) : "",
      weight: String(o.weight),
      backup: o.backup,
    })),
    maxFails: String(app.maxFails),
    failTimeoutSeconds: String(app.failTimeoutSeconds),
    connectTimeout: String(app.connectTimeoutMs / 1000),
    idleTimeoutSeconds: String(app.idleTimeoutSeconds),
    allowListIds: app.allowListIds,
    blockListIds: app.blockListIds,
    maxConnections: String(app.maxConnections),
    newConnectionsPerSecond: String(app.newConnectionsPerSecond),
  };
}

const toInt = (value: string, fallback: number) => {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? Math.round(n) : fallback;
};

/** Which part of the form a refusal concerns; the rest show under the form. */
type ErrorField = "port" | "origins" | "proxy" | "tls" | "lists" | "form";
const ERROR_FIELDS: Record<string, ErrorField> = {
  L4_PORT_OUTSIDE_POOL: "port",
  L4_PORT_IN_USE: "port",
  L4_PORT_RESERVED: "port",
  L4_PORT_RANGE_INVALID: "port",
  L4_PORT_LIMIT: "port",
  L4_ORIGIN_PORT_REQUIRED: "origins",
  L4_TLS_UNSUPPORTED: "tls",
  L4_CERTIFICATE_UNAVAILABLE: "tls",
  CERTIFICATE_NOT_FOUND: "tls",
  ORIGIN_ADDRESS_FORBIDDEN: "origins",
  L4_PROXY_PROTOCOL_UNSUPPORTED: "proxy",
  IP_LIST_NOT_FOUND: "lists",
};

/**
 * Create a layer-4 application, or edit `app`. The form mounts with the dialog, so every
 * opening starts from the application (or the defaults) again.
 */
export function L4AppDialog({
  open,
  onOpenChange,
  app,
  clusters,
  clusterId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app?: L4App;
  /** Oldest first; a new application goes to `clusterId` or the oldest cluster. */
  clusters: { id: string; name: string }[];
  clusterId?: string;
  onSaved?: (app: L4App) => void;
}) {
  const initialCluster =
    app?.clusterId ??
    (clusters.some((c) => c.id === clusterId) ? clusterId : clusters[0]?.id) ??
    "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{app ? m.l4_edit() : m.l4_create()}</DialogTitle>
        </DialogHeader>
        <AppForm
          key={app?.id ?? "new"}
          app={app}
          clusters={clusters}
          initial={draftOf(app, initialCluster)}
          onDone={(saved) => {
            onSaved?.(saved);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function AppForm({
  app,
  clusters,
  initial,
  onDone,
}: {
  app?: L4App;
  clusters: { id: string; name: string }[];
  initial: AppDraft;
  onDone: (app: L4App) => void;
}) {
  const queryClient = useQueryClient();
  const uid = React.useId();
  const id = (name: string) => `${uid}-${name}`;
  const [draft, setDraft] = React.useState(initial);
  // Opened before the clusters loaded, a new application takes the default cluster once they have.
  const clusterId = draft.clusterId || initial.clusterId;
  // A new application's idle timeout follows the protocol until it is edited.
  const [idleEdited, setIdleEdited] = React.useState(Boolean(app));
  const [refusal, setRefusal] = React.useState<{ field: ErrorField; message: string } | null>(null);
  const create = useMutation(orpc.l4Apps.create.mutationOptions());
  const update = useMutation(orpc.l4Apps.update.mutationOptions());
  const pending = create.isPending || update.isPending;
  const pools = useQuery({
    ...orpc.clusters.portPools.queryOptions({ input: { clusterId } }),
    enabled: !!clusterId,
  });
  const lists = useQuery(orpc.ipLists.list.queryOptions());
  const certificates = useQuery(orpc.certificates.list.queryOptions());
  // Ranges, origins on the arriving port and TLS wait for nodes with l4-v2,
  // unless the application already has them.
  const v2Locked = (pools.data?.nodesWithoutL4V2.length ?? 0) > 0;
  const lockedUnlessSaved = (saved: boolean) => v2Locked && !saved;
  const set = (change: Partial<AppDraft>) => {
    setDraft((previous) => ({ ...previous, ...change }));
    setRefusal(null);
  };
  const udp = draft.protocol === "udp";
  const noPrimary = !draft.origins.some((o) => !o.backup);
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? app?.clusterName;
  const protocolPools = (pools.data?.pools ?? []).filter(
    (pool) => pool.protocol === "both" || pool.protocol === draft.protocol,
  );
  const port = Number(draft.port);
  const portEnd = draft.portEnd.trim() ? Number(draft.portEnd) : port;
  const badRange =
    draft.portEnd.trim() !== "" &&
    (!Number.isInteger(portEnd) || portEnd <= port || portEnd - port >= MAX_L4_RANGE_PORTS);
  const outsidePools =
    pools.isSuccess &&
    draft.port.trim() !== "" &&
    Number.isInteger(port) &&
    !badRange &&
    Array.from({ length: portEnd - port + 1 }, (_, i) => port + i).some(
      (p) => !protocolPools.some((pool) => poolCovers(pool, draft.protocol, p)),
    );
  const same = draft.originPortMode === "same";
  const errorFor = (field: ErrorField) =>
    refusal?.field === field ? (
      <FieldError className="animate-in fade-in" data-testid={`l4-app-${field}-error`}>
        {refusal.message}
      </FieldError>
    ) : null;
  const patchOrigin = (key: number, change: Partial<OriginDraft>) =>
    set({ origins: draft.origins.map((o) => (o.key === key ? { ...o, ...change } : o)) });

  const submit = async () => {
    const fields = {
      name: draft.name.trim(),
      protocol: draft.protocol,
      port: toInt(draft.port, 0),
      portEnd: draft.portEnd.trim() ? toInt(draft.portEnd, 0) : null,
      originPortMode: draft.originPortMode,
      certificateId: udp || draft.certificateId === NO_TLS ? null : draft.certificateId,
      tlsMinimumVersion: draft.tlsMinimumVersion,
      acceptProxyProtocol: udp ? false : draft.acceptProxyProtocol,
      proxyProtocolVersion: udp ? 0 : draft.proxyProtocolVersion,
      origins: draft.origins.map((o) => ({
        address: o.address.trim(),
        port: same ? undefined : toInt(o.port, 0),
        weight: toInt(o.weight, 1),
        backup: o.backup,
      })),
      maxFails: toInt(draft.maxFails, L4_APP_DEFAULTS.maxFails),
      failTimeoutSeconds: toInt(draft.failTimeoutSeconds, L4_APP_DEFAULTS.failTimeoutSeconds),
      connectTimeoutMs: Math.round(Number(draft.connectTimeout) * 1000),
      idleTimeoutSeconds: toInt(
        draft.idleTimeoutSeconds,
        L4_APP_DEFAULTS.idleTimeoutSeconds[draft.protocol],
      ),
      allowListIds: draft.allowListIds,
      blockListIds: draft.blockListIds,
      maxConnections: toInt(draft.maxConnections, 0),
      newConnectionsPerSecond: toInt(draft.newConnectionsPerSecond, 0),
    };
    setRefusal(null);
    try {
      const result = app
        ? await update.mutateAsync({ id: app.id, expectedUpdatedAt: app.updatedAt, ...fields })
        : await create.mutateAsync({
            clusterId,
            enabled: draft.enabled,
            ...fields,
          });
      queryClient.setQueryData(
        orpc.l4Apps.get.queryKey({ input: { id: result.app.id } }),
        result.app,
      );
      await queryClient.invalidateQueries({ queryKey: orpc.l4Apps.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.clusters.key() });
      toast.success(
        app
          ? m.site_saved({ revision: result.revision.revision })
          : m.site_form_created({ revision: result.revision.revision }),
      );
      onDone(result.app);
    } catch (error) {
      const { code } = apiError(error);
      setRefusal({
        field: (code && ERROR_FIELDS[code]) || "form",
        message: errorMessage(error),
      });
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-testid="l4-app-form"
    >
      <FieldGroup className="gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={id("name")}>{m.site_form_name()}</FieldLabel>
            <Input
              id={id("name")}
              value={draft.name}
              required
              maxLength={100}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="game-tcp"
              data-testid="l4-app-name"
            />
          </Field>
          {app || clusters.length <= 1 ? (
            <Field>
              <FieldLabel>{m.sites_col_cluster()}</FieldLabel>
              <div className="flex h-9 items-center">
                <Badge variant="secondary" data-testid="l4-app-cluster-name">
                  {clusterName}
                </Badge>
              </div>
            </Field>
          ) : (
            <FormSelect
              id={id("cluster")}
              label={m.sites_col_cluster()}
              value={clusterId}
              options={clusters.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(clusterId) => set({ clusterId })}
              testId="l4-app-cluster"
            />
          )}
        </div>
        {pools.data && clusterName ? (
          <L4NodesWarning cluster={clusterName} nodes={pools.data.nodesWithoutL4} />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
          <FormSelect
            id={id("protocol")}
            label={m.l4_protocol()}
            value={draft.protocol}
            options={L4_PROTOCOLS}
            onChange={(protocol) =>
              set({
                protocol,
                // UDP takes no PROXY protocol.
                ...(protocol === "udp"
                  ? { acceptProxyProtocol: false, proxyProtocolVersion: 0 }
                  : {}),
                ...(idleEdited
                  ? {}
                  : { idleTimeoutSeconds: String(L4_APP_DEFAULTS.idleTimeoutSeconds[protocol]) }),
              })
            }
            testId="l4-app-protocol-select"
          />
          <Field data-invalid={refusal?.field === "port" || undefined}>
            <FieldLabel htmlFor={id("port")}>{m.l4_port()}</FieldLabel>
            <Input
              id={id("port")}
              type="number"
              inputMode="numeric"
              min={1024}
              max={65535}
              step={1}
              required
              value={draft.port}
              aria-invalid={refusal?.field === "port" || undefined}
              onChange={(event) => set({ port: event.target.value })}
              className="font-mono"
              data-testid="l4-app-port"
            />
            {errorFor("port")}
            <PoolsHint
              clusterId={clusterId}
              protocol={draft.protocol}
              pools={protocolPools}
              loaded={pools.isSuccess}
              outside={outsidePools}
            />
          </Field>
          <Field data-disabled={lockedUnlessSaved(!!app?.portEnd) || undefined}>
            <FieldLabel htmlFor={id("port-end")}>{m.l4_port_end()}</FieldLabel>
            <Input
              id={id("port-end")}
              type="number"
              inputMode="numeric"
              min={1024}
              max={65535}
              step={1}
              value={draft.portEnd}
              disabled={lockedUnlessSaved(!!app?.portEnd)}
              aria-invalid={badRange || undefined}
              onChange={(event) => set({ portEnd: event.target.value })}
              className="font-mono"
              data-testid="l4-app-port-end"
            />
            {badRange ? (
              <FieldError className="animate-in fade-in" data-testid="l4-app-port-end-invalid">
                {m.l4_port_end_invalid()}
              </FieldError>
            ) : null}
          </Field>
        </div>
        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-0 text-muted-foreground">
            {m.sites_col_origins()}
          </FieldLegend>
          <Field
            className="sm:max-w-56"
            data-disabled={lockedUnlessSaved(app?.originPortMode === "same") || undefined}
          >
            <FieldLabel htmlFor={id("origin-port-mode")}>{m.l4_origin_port_mode()}</FieldLabel>
            <OptionSelect
              id={id("origin-port-mode")}
              value={draft.originPortMode}
              options={[
                { value: "fixed" as const, label: m.l4_origin_port_fixed() },
                { value: "same" as const, label: m.l4_origin_port_same() },
              ]}
              onChange={(originPortMode) => set({ originPortMode })}
              disabled={lockedUnlessSaved(app?.originPortMode === "same")}
              testId="l4-app-origin-port-mode"
            />
          </Field>
          {/* Flat rows split by hairlines, not boxes in the dialog. */}
          <ol className="flex flex-col border-y">
            {draft.origins.map((origin, index) => (
              <OriginRow
                key={origin.key}
                origin={origin}
                portless={same}
                index={index}
                removable={draft.origins.length > 1}
                onChange={(change) => patchOrigin(origin.key, change)}
                onRemove={() => set({ origins: draft.origins.filter((o) => o.key !== origin.key) })}
              />
            ))}
          </ol>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            disabled={draft.origins.length >= MAX_L4_ORIGINS}
            onClick={() => set({ origins: [...draft.origins, newOrigin()] })}
            data-testid="l4-origin-add"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.site_origin_add()}
          </Button>
          {noPrimary ? (
            <FieldError className="animate-in fade-in" data-testid="l4-origin-primary-required">
              {m.l4_origin_primary_required()}
            </FieldError>
          ) : null}
          {errorFor("origins")}
        </FieldSet>
        <FieldSet className="gap-2">
          <FieldLegend variant="label" className="mb-1 text-muted-foreground">
            {m.l4_proxy()}
          </FieldLegend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field data-disabled={udp || undefined}>
              <FieldLabel htmlFor={id("proxy-send")}>{m.l4_proxy_send()}</FieldLabel>
              <OptionSelect
                id={id("proxy-send")}
                value={String(draft.proxyProtocolVersion)}
                options={PROXY_VERSIONS.map((v) => ({
                  label: proxyVersionLabel(v),
                  value: String(v),
                }))}
                onChange={(value) => set({ proxyProtocolVersion: Number(value) })}
                disabled={udp}
                testId="l4-app-proxy-send"
              />
            </Field>
            <SwitchField
              id={id("proxy-accept")}
              label={m.l4_proxy_accept()}
              checked={draft.acceptProxyProtocol}
              disabled={udp}
              onCheckedChange={(acceptProxyProtocol) => set({ acceptProxyProtocol })}
              className="self-end"
              testId="l4-app-proxy-accept"
            />
          </div>
          {udp ? (
            <SafetyNote className="animate-in fade-in" data-testid="l4-app-proxy-udp">
              {m.l4_proxy_udp()}
            </SafetyNote>
          ) : null}
          {errorFor("proxy")}
        </FieldSet>
        <FieldSet className="gap-2">
          <FieldLegend variant="label" className="mb-1 text-muted-foreground">
            {m.l4_tls_certificate()}
          </FieldLegend>
          <div className="grid gap-3 sm:grid-cols-2">
            <OptionSelect
              id={id("tls-certificate")}
              value={udp ? NO_TLS : draft.certificateId}
              disabled={udp || lockedUnlessSaved(!!app?.certificateId)}
              options={[
                { value: NO_TLS, label: m.l4_tls_none() },
                ...(certificates.data ?? [])
                  .filter(
                    (c) =>
                      c.id === app?.certificateId ||
                      (!!c.fingerprint &&
                        !!c.notAfter &&
                        Date.parse(c.notAfter) > Date.now() &&
                        !certificateUnloadable(c)),
                  )
                  .map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={(certificateId) => set({ certificateId })}
              label={m.cert_title()}
              testId="l4-app-tls-certificate"
            />
            <OptionSelect
              id={id("tls-version")}
              value={draft.tlsMinimumVersion}
              disabled={udp || draft.certificateId === NO_TLS}
              options={[
                { value: "1.2" as const, label: m.cert_tls12() },
                { value: "1.3" as const, label: m.cert_tls13() },
              ]}
              onChange={(tlsMinimumVersion) => set({ tlsMinimumVersion })}
              label={m.cert_min_tls()}
              testId="l4-app-tls-version"
            />
          </div>
          {udp ? (
            <SafetyNote className="animate-in fade-in" data-testid="l4-app-tls-udp">
              {m.l4_tls_tcp_only()}
            </SafetyNote>
          ) : null}
          {v2Locked ? (
            <SafetyNote className="animate-in fade-in" data-testid="l4-app-v2-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          ) : null}
          {errorFor("tls")}
        </FieldSet>
        <div className="grid gap-6 sm:grid-cols-2">
          <SettingsGroup legend={m.l4_timeouts()} className="lg:grid-cols-2">
            <NumberField
              id={id("connect-timeout")}
              label={m.l4_connect_timeout()}
              value={draft.connectTimeout}
              min={0.1}
              max={60}
              step="any"
              required
              onChange={(connectTimeout) => set({ connectTimeout })}
              testId="l4-app-connect-timeout"
            />
            <NumberField
              id={id("idle-timeout")}
              label={m.l4_idle_timeout()}
              value={draft.idleTimeoutSeconds}
              min={1}
              max={86400}
              step={1}
              required
              onChange={(idleTimeoutSeconds) => {
                setIdleEdited(true);
                set({ idleTimeoutSeconds });
              }}
              testId="l4-app-idle-timeout"
            />
          </SettingsGroup>
          <SettingsGroup legend={m.site_pool_health()} className="lg:grid-cols-2">
            <NumberField
              id={id("max-fails")}
              label={m.site_pool_max_fails()}
              value={draft.maxFails}
              min={1}
              max={100}
              step={1}
              required
              onChange={(maxFails) => set({ maxFails })}
              testId="l4-app-max-fails"
            />
            <NumberField
              id={id("fail-timeout")}
              label={m.site_pool_recovery()}
              value={draft.failTimeoutSeconds}
              min={1}
              max={3600}
              step={1}
              required
              onChange={(failTimeoutSeconds) => set({ failTimeoutSeconds })}
              testId="l4-app-fail-timeout"
            />
          </SettingsGroup>
        </div>
        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-0 text-muted-foreground">
            {m.ip_lists_title()}
          </FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            <ListPicker
              label={m.l4_allow_lists()}
              lists={lists.data ?? []}
              value={draft.allowListIds}
              onChange={(allowListIds) => set({ allowListIds })}
              testId="l4-app-allow-lists"
            />
            <ListPicker
              label={m.l4_block_lists()}
              lists={lists.data ?? []}
              value={draft.blockListIds}
              onChange={(blockListIds) => set({ blockListIds })}
              testId="l4-app-block-lists"
            />
          </div>
          {errorFor("lists")}
        </FieldSet>
        <div className="flex flex-col gap-2">
          <SettingsGroup legend={m.l4_limits()}>
            <NumberField
              id={id("max-connections")}
              label={m.l4_max_connections()}
              value={draft.maxConnections}
              min={0}
              max={10_000_000}
              step={1}
              required
              onChange={(maxConnections) => set({ maxConnections })}
              testId="l4-app-max-connections"
            />
            <NumberField
              id={id("new-connections")}
              label={m.l4_new_connections()}
              value={draft.newConnectionsPerSecond}
              min={0}
              max={1_000_000}
              step={1}
              required
              onChange={(newConnectionsPerSecond) => set({ newConnectionsPerSecond })}
              testId="l4-app-new-connections"
            />
          </SettingsGroup>
          <SafetyNote>{m.l4_limits_note()}</SafetyNote>
        </div>
        {app ? null : (
          <SwitchField
            id={id("enabled")}
            label={m.l4_enabled()}
            checked={draft.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
            className="self-start"
            testId="l4-app-enabled-input"
          />
        )}
        {errorFor("form")}
        <DialogFooter>
          <Button
            type="submit"
            disabled={pending || noPrimary || !clusterId}
            data-testid="l4-app-submit"
          >
            {pending ? <Spinner /> : null}
            {app ? m.common_save() : m.common_create()}
          </Button>
        </DialogFooter>
      </FieldGroup>
    </form>
  );
}

/** The pools the port has to fall in, or a way to set them up when the cluster has none. */
function PoolsHint({
  clusterId,
  protocol,
  pools,
  loaded,
  outside,
}: {
  clusterId: string;
  protocol: L4Protocol;
  pools: { protocol: "tcp" | "udp" | "both"; from: number; to: number }[];
  loaded: boolean;
  outside: boolean;
}) {
  if (!loaded) return null;
  if (pools.length === 0)
    return (
      <SafetyNote className="flex flex-wrap items-center gap-x-2" data-testid="l4-app-pools-none">
        <span>{m.l4_pools_none({ protocol: protocolLabel(protocol) })}</span>
        <Link
          to="/clusters"
          search={{ cluster: clusterId, tab: "ports" }}
          className="text-foreground underline underline-offset-4"
        >
          {m.l4_pools_setup()}
        </Link>
      </SafetyNote>
    );
  return (
    <SafetyNote
      className={cn("font-mono text-xs", outside && "text-destructive")}
      data-testid="l4-app-pools-hint"
      data-outside={outside || undefined}
    >
      {m.l4_pools_hint({ pools: pools.map(poolLabel).join(" · ") })}
    </SafetyNote>
  );
}

function OriginRow({
  origin,
  portless,
  index,
  removable,
  onChange,
  onRemove,
}: {
  origin: OriginDraft;
  /** Origins take the port the connection arrived on. */
  portless: boolean;
  index: number;
  removable: boolean;
  onChange: (change: Partial<OriginDraft>) => void;
  onRemove: () => void;
}) {
  const uid = React.useId();
  const id = (name: string) => `${uid}-${name}`;
  return (
    <li
      className="grid grid-cols-2 items-end gap-3 border-t py-3 animate-enter first:border-t-0 sm:grid-cols-[minmax(0,1fr)_6rem_5rem_auto_auto]"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      aria-label={m.site_origin_number({ index: index + 1 })}
      data-testid="l4-origin-row"
    >
      <Field className="col-span-2 sm:col-span-1">
        <FieldLabel htmlFor={id("address")}>{m.site_form_origin()}</FieldLabel>
        <Input
          id={id("address")}
          value={origin.address}
          required
          maxLength={253}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onChange({ address: event.target.value })}
          placeholder="origin.example.com"
          className="font-mono"
          data-testid="l4-origin-address"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id("port")}>{m.site_form_port()}</FieldLabel>
        <Input
          id={id("port")}
          type="number"
          inputMode="numeric"
          min={1}
          max={65535}
          step={1}
          required={!portless}
          disabled={portless}
          value={portless ? "" : origin.port}
          placeholder={portless ? m.l4_origin_port_same() : undefined}
          onChange={(event) => onChange({ port: event.target.value })}
          className="font-mono"
          data-testid="l4-origin-port"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={id("weight")}>{m.site_origin_weight()}</FieldLabel>
        <Input
          id={id("weight")}
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step={1}
          required
          value={origin.weight}
          onChange={(event) => onChange({ weight: event.target.value })}
          data-testid="l4-origin-weight"
        />
      </Field>
      <SwitchField
        id={id("backup")}
        label={m.site_origin_backup()}
        checked={origin.backup}
        onCheckedChange={(backup) => onChange({ backup })}
        className="self-end justify-self-start"
        testId="l4-origin-backup"
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="mb-0.5 justify-self-end"
        aria-label={m.common_remove()}
        disabled={!removable}
        onClick={onRemove}
        data-testid="l4-origin-remove"
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
      </Button>
    </li>
  );
}

/** IP lists picked by name; each can be taken out again. */
function ListPicker({
  label,
  lists,
  value,
  onChange,
  testId,
}: {
  label: string;
  lists: { id: string; name: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  testId: string;
}) {
  const remaining = lists.filter((list) => !value.includes(list.id));
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <span className="text-sm font-medium">{label}</span>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5">
        {value.length === 0 ? (
          <span className="text-sm text-muted-foreground" data-testid={`${testId}-none`}>
            {m.l4_lists_none()}
          </span>
        ) : (
          listChips(value, lists).map(({ id: listId, name }) => {
            return (
              <Badge
                key={listId}
                variant="secondary"
                className="h-7 gap-1 pr-1 font-mono animate-enter"
                data-testid={`${testId}-item`}
                data-list={name}
              >
                {name}
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label={m.l4_list_remove({ name })}
                  onClick={() => onChange(value.filter((other) => other !== listId))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
                </button>
              </Badge>
            );
          })
        )}
        {remaining.length > 0 && value.length < MAX_L4_APP_LISTS ? (
          <OptionSelect
            value={null}
            options={remaining.map((list) => ({ value: list.id, label: list.name }))}
            onChange={(listId) => onChange([...value, listId])}
            placeholder={m.l4_list_add()}
            label={m.l4_list_add()}
            size="sm"
            className="w-fit"
            testId={`${testId}-add`}
          />
        ) : null}
      </div>
    </div>
  );
}
