import {
  CLIENT_IP_HEADERS,
  type ClientIpMode,
  type ClusterClientIp,
  type ClusterListenPorts,
  type ClusterUnknownHosts,
  clientIpSettings,
  listenPortsInput,
  SCAN_BAN_SECONDS,
  SCAN_THRESHOLD,
  type UnknownHostAction,
  unknownHostSettings,
} from "@edgeweir/contract";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { OptionSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { ListInput, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/**
 * The cluster page's network tab: listener ports, the client address
 * setting and the handling of unknown hosts and node IP access.
 */
export function ClusterNetwork({ clusterId }: { clusterId: string }) {
  const ports = useQuery(orpc.clusters.listenPorts.queryOptions({ input: { clusterId } }));
  const clientIp = useQuery(orpc.clusters.clientIp.queryOptions({ input: { clusterId } }));
  const unknownHosts = useQuery(orpc.clusters.unknownHosts.queryOptions({ input: { clusterId } }));
  // Each card and its title stay while its setting loads or fails to.
  return (
    <div className="flex flex-col gap-4">
      <Card className="animate-enter" data-testid="listen-ports">
        <CardHeader>
          <CardTitle>{m.listen_ports_title()}</CardTitle>
        </CardHeader>
        <QueryView query={ports} frame={CardContent}>
          {(data) => <ListenPortsForm key={JSON.stringify(data)} data={data} />}
        </QueryView>
      </Card>
      <Card className="animate-enter" style={{ animationDelay: "60ms" }} data-testid="client-ip">
        <CardHeader>
          <CardTitle>{m.client_ip_title()}</CardTitle>
        </CardHeader>
        <QueryView query={clientIp} frame={CardContent}>
          {(data) => <ClientIpForm key={JSON.stringify(data.settings)} data={data} />}
        </QueryView>
      </Card>
      <Card
        className="animate-enter"
        style={{ animationDelay: "120ms" }}
        data-testid="unknown-hosts"
      >
        <CardHeader>
          <CardTitle>{m.unknown_hosts_title()}</CardTitle>
        </CardHeader>
        <QueryView query={unknownHosts} frame={CardContent}>
          {(data) => <UnknownHostsForm key={JSON.stringify(data.settings)} data={data} />}
        </QueryView>
      </Card>
    </div>
  );
}

const toNumbers = (list: string[]) => list.map((value) => Number(value));

function ListenPortsForm({ data }: { data: ClusterListenPorts }) {
  const client = useQueryClient();
  const initial = { http: data.httpPorts.map(String), https: data.httpsPorts.map(String) };
  const [draft, setDraft] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation(orpc.clusters.setListenPorts.mutationOptions());
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useUnsavedChanges(dirty);
  const parsed = listenPortsInput.safeParse({
    clusterId: data.clusterId,
    httpPorts: toNumbers(draft.http),
    httpsPorts: toNumbers(draft.https),
  });
  // New ports wait for nodes that know them; removing ports always works.
  const locked = data.nodesWithout.length > 0;
  const grows =
    draft.http.some((p) => !initial.http.includes(p)) ||
    draft.https.some((p) => !initial.https.includes(p));
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!parsed.success) return;
        setError(null);
        try {
          const result = await save.mutateAsync(parsed.data);
          client.setQueryData(
            orpc.clusters.listenPorts.queryKey({ input: { clusterId: data.clusterId } }),
            result,
          );
          await client.invalidateQueries({ queryKey: orpc.clusters.portPools.key() });
          toast.success(m.common_saved());
        } catch (e) {
          setError(errorMessage(e));
        }
      }}
    >
      <CardContent className="flex flex-col gap-4">
        <div
          className="flex flex-wrap items-center gap-2 text-sm"
          data-testid="listen-ports-always"
        >
          <span className="text-muted-foreground">{m.listen_ports_always()}</span>
          <Badge variant="secondary" className="font-mono">
            80
          </Badge>
          <Badge variant="secondary" className="font-mono">
            443
          </Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="listen-http">{m.listen_ports_http()}</FieldLabel>
            <ListInput
              id="listen-http"
              value={draft.http}
              placeholder="8080, 8081"
              invalid={!parsed.success}
              onChange={(http) => setDraft({ ...draft, http })}
              testId="listen-ports-http"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="listen-https">{m.listen_ports_https()}</FieldLabel>
            <ListInput
              id="listen-https"
              value={draft.https}
              placeholder="8443, 9443"
              invalid={!parsed.success}
              onChange={(https) => setDraft({ ...draft, https })}
              testId="listen-ports-https"
            />
          </Field>
        </div>
        {parsed.success ? null : (
          <FieldError className="animate-in fade-in" data-testid="listen-ports-invalid">
            {m.listen_ports_invalid()}
          </FieldError>
        )}
        {locked ? (
          <SafetyNote data-testid="listen-ports-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        ) : null}
      </CardContent>
      {/* The save row of settings cards; the guard for unsaved changes stays on `dirty` above. */}
      <SaveBar
        dirty={dirty && parsed.success && !(locked && grows)}
        pending={save.isPending}
        error={error}
        testId="listen-ports-save"
        errorTestId="listen-ports-error"
      />
    </form>
  );
}

const MODES: { value: ClientIpMode; label: () => string }[] = [
  { value: "direct", label: m.client_ip_mode_direct },
  { value: "proxy_protocol", label: m.client_ip_mode_proxy_protocol },
  { value: "header", label: m.client_ip_mode_header },
];

const CUSTOM = "custom";

function ClientIpForm({ data }: { data: ClusterClientIp }) {
  const client = useQueryClient();
  const saved = data.settings;
  const [mode, setMode] = React.useState(saved.mode);
  const [cidrs, setCidrs] = React.useState(saved.trustedCidrs.join("\n"));
  const preset = (CLIENT_IP_HEADERS as readonly string[]).includes(saved.header);
  const [header, setHeader] = React.useState(
    saved.header === "" ? "x-forwarded-for" : preset ? saved.header : CUSTOM,
  );
  const [custom, setCustom] = React.useState(preset ? "" : saved.header);
  const [drop, setDrop] = React.useState(saved.dropForwardedFor);
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation(orpc.clusters.setClientIp.mutationOptions());
  const settings = {
    mode,
    trustedCidrs: mode === "header" ? cidrs.split(/[\s,]+/).filter(Boolean) : [],
    header: mode === "header" ? (header === CUSTOM ? custom : header) : "",
    dropForwardedFor: mode === "direct" && drop,
  };
  const parsed = clientIpSettings.safeParse(settings);
  const normalized = parsed.success ? parsed.data : null;
  const dirty = JSON.stringify(normalized ?? settings) !== JSON.stringify(saved);
  useUnsavedChanges(dirty);
  const locked = data.nodesWithout.length > 0 && mode !== "direct";
  const cidrError =
    !parsed.success && parsed.error.issues.some((i) => i.path[0] === "trustedCidrs");
  const headerError = !parsed.success && parsed.error.issues.some((i) => i.path[0] === "header");
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!normalized) return;
        setError(null);
        try {
          const result = await save.mutateAsync({
            clusterId: data.clusterId,
            settings: normalized,
          });
          client.setQueryData(
            orpc.clusters.clientIp.queryKey({ input: { clusterId: data.clusterId } }),
            result,
          );
          await client.invalidateQueries({ queryKey: orpc.clusters.list.key() });
          toast.success(m.common_saved());
        } catch (e) {
          setError(errorMessage(e));
        }
      }}
    >
      <CardContent className="flex flex-col gap-4">
        <Field className="sm:max-w-xs">
          <FieldLabel htmlFor="client-ip-mode">{m.client_ip_mode()}</FieldLabel>
          <OptionSelect
            id="client-ip-mode"
            value={mode}
            options={MODES.map((option) => ({ value: option.value, label: option.label() }))}
            onChange={setMode}
            testId="client-ip-mode"
          />
        </Field>
        {mode === "direct" ? (
          <SwitchField
            id="client-ip-drop"
            label={m.client_ip_drop_xff()}
            checked={drop}
            onCheckedChange={setDrop}
            className="self-start"
            testId="client-ip-drop"
          />
        ) : null}
        {mode === "proxy_protocol" ? (
          <SafetyNote data-testid="client-ip-proxy-note">{m.client_ip_proxy_note()}</SafetyNote>
        ) : null}
        {mode === "header" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="client-ip-cidrs">{m.client_ip_cidrs()}</FieldLabel>
              <Textarea
                id="client-ip-cidrs"
                value={cidrs}
                rows={4}
                placeholder={"10.0.0.0/8\n2001:db8::/32"}
                aria-invalid={cidrError || undefined}
                aria-describedby={cidrError ? "client-ip-cidrs-invalid" : undefined}
                onChange={(event) => setCidrs(event.target.value)}
                className="font-mono"
                data-testid="client-ip-cidrs"
              />
              {cidrError ? (
                <FieldError id="client-ip-cidrs-invalid" data-testid="client-ip-cidrs-invalid">
                  {m.client_ip_cidrs_invalid()}
                </FieldError>
              ) : null}
            </Field>
            <div className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="client-ip-header">{m.client_ip_header()}</FieldLabel>
                <OptionSelect
                  id="client-ip-header"
                  value={header}
                  options={[
                    ...CLIENT_IP_HEADERS.map((name) => ({ value: name, label: name })),
                    { value: CUSTOM, label: m.client_ip_header_custom() },
                  ]}
                  onChange={setHeader}
                  testId="client-ip-header"
                />
              </Field>
              {header === CUSTOM ? (
                <Field data-invalid={headerError || undefined}>
                  <FieldLabel htmlFor="client-ip-header-name">
                    {m.client_ip_header_name()}
                  </FieldLabel>
                  <Input
                    id="client-ip-header-name"
                    value={custom}
                    placeholder="x-client-ip"
                    aria-invalid={headerError || undefined}
                    aria-describedby={headerError ? "client-ip-header-name-invalid" : undefined}
                    onChange={(event) => setCustom(event.target.value)}
                    className="font-mono"
                    data-testid="client-ip-header-name"
                  />
                  {headerError ? (
                    <FieldError
                      id="client-ip-header-name-invalid"
                      className="animate-in fade-in"
                      data-testid="client-ip-header-name-invalid"
                    >
                      {m.common_check_field({ field: m.client_ip_header_name() })}
                    </FieldError>
                  ) : null}
                </Field>
              ) : null}
            </div>
          </div>
        ) : null}
        {locked ? (
          <SafetyNote data-testid="client-ip-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        ) : null}
      </CardContent>
      <SaveBar
        dirty={dirty && !!normalized && !locked}
        pending={save.isPending}
        error={error}
        testId="client-ip-save"
        errorTestId="client-ip-error"
      />
    </form>
  );
}

const ACTIONS: { value: UnknownHostAction; label: () => string }[] = [
  { value: "page", label: m.unknown_hosts_action_page },
  { value: "close", label: m.unknown_hosts_action_close },
  { value: "site", label: m.unknown_hosts_action_site },
];

function UnknownHostsForm({ data }: { data: ClusterUnknownHosts }) {
  const client = useQueryClient();
  const saved = data.settings;
  const [unknownHost, setUnknownHost] = React.useState(saved.unknownHost);
  const [ipAccess, setIpAccess] = React.useState(saved.ipAccess);
  const [siteId, setSiteId] = React.useState(saved.defaultSiteId ?? "");
  const [certificate, setCertificate] = React.useState(saved.defaultCertificate);
  const [scan, setScan] = React.useState(saved.scan.enabled);
  const [threshold, setThreshold] = React.useState(String(saved.scan.threshold));
  const [banSeconds, setBanSeconds] = React.useState(String(saved.scan.banSeconds));
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation(orpc.clusters.setUnknownHosts.mutationOptions());
  const handsOver = unknownHost === "site" || ipAccess === "site";
  // Enabled sites of the cluster may take requests, found by name or domain
  // (a cluster holds more sites than one page); the chosen one stays listed.
  const [siteSearch, setSiteSearch] = React.useState("");
  const [siteQuery, setSiteQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setSiteQuery(siteSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [siteSearch]);
  const [chosen, setChosen] = React.useState(
    data.defaultSite ? { value: data.defaultSite.id, label: data.defaultSite.name } : null,
  );
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({
      input: { clusterId: data.clusterId, search: siteQuery || undefined, pageSize: 100 },
    }),
    enabled: handsOver,
    placeholderData: keepPreviousData,
  });
  const items = sites.data?.items ?? [];
  const options = [
    ...(chosen && chosen.value === siteId && !items.some((site) => site.id === chosen.value)
      ? [chosen]
      : []),
    ...items
      .filter((site) => site.enabled || site.id === saved.defaultSiteId)
      .map((site) => ({ value: site.id, label: site.name })),
  ];
  const pickSite = (value: string) => {
    setSiteId(value);
    const site = items.find((item) => item.id === value);
    if (site) setChosen({ value: site.id, label: site.name });
  };
  // Scan values the switch hides are not checked: back to the saved ones.
  const toggleScan = (on: boolean) => {
    setScan(on);
    if (!on) {
      setThreshold(String(saved.scan.threshold));
      setBanSeconds(String(saved.scan.banSeconds));
    }
  };
  const settings = {
    unknownHost,
    ipAccess,
    defaultSiteId: handsOver && siteId ? siteId : null,
    defaultCertificate: unknownHost === "site" && certificate,
    scan: { enabled: scan, threshold: Number(threshold), banSeconds: Number(banSeconds) },
  };
  const parsed = unknownHostSettings.safeParse(settings);
  const normalized = parsed.success ? parsed.data : null;
  const dirty = JSON.stringify(normalized ?? settings) !== JSON.stringify(saved);
  useUnsavedChanges(dirty);
  const defaults =
    unknownHost === "page" && ipAccess === "page" && !scan && !settings.defaultCertificate;
  const locked = data.nodesWithout.length > 0 && !defaults;
  const scanError = !parsed.success && parsed.error.issues.some((i) => i.path[0] === "scan");
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!normalized) return;
        setError(null);
        try {
          const result = await save.mutateAsync({
            clusterId: data.clusterId,
            settings: normalized,
          });
          client.setQueryData(
            orpc.clusters.unknownHosts.queryKey({ input: { clusterId: data.clusterId } }),
            result,
          );
          toast.success(m.common_saved());
        } catch (e) {
          setError(errorMessage(e));
        }
      }}
    >
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="unknown-hosts-unknown">{m.unknown_hosts_unknown()}</FieldLabel>
            <OptionSelect
              id="unknown-hosts-unknown"
              value={unknownHost}
              options={ACTIONS.map((option) => ({ value: option.value, label: option.label() }))}
              onChange={setUnknownHost}
              testId="unknown-hosts-unknown"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="unknown-hosts-ip">{m.unknown_hosts_ip_access()}</FieldLabel>
            <OptionSelect
              id="unknown-hosts-ip"
              value={ipAccess}
              options={ACTIONS.map((option) => ({ value: option.value, label: option.label() }))}
              onChange={setIpAccess}
              testId="unknown-hosts-ip"
            />
          </Field>
        </div>
        {handsOver ? (
          <div className="flex flex-col gap-4 animate-enter">
            <Field className="sm:max-w-xs" data-invalid={!siteId || undefined}>
              <FieldLabel htmlFor="unknown-hosts-site">{m.unknown_hosts_default_site()}</FieldLabel>
              <Input
                value={siteSearch}
                onChange={(event) => setSiteSearch(event.target.value)}
                aria-label={m.bans_site_search()}
                placeholder={m.sites_search_placeholder()}
                data-testid="unknown-hosts-site-search"
              />
              <OptionSelect
                id="unknown-hosts-site"
                value={siteId || null}
                options={options}
                placeholder={m.unknown_hosts_choose_site()}
                onChange={pickSite}
                testId="unknown-hosts-site"
              />
            </Field>
            {data.defaultSite && !data.defaultSite.enabled && siteId === data.defaultSite.id ? (
              <SafetyNote data-testid="unknown-hosts-site-disabled">
                {m.unknown_hosts_default_disabled()}
              </SafetyNote>
            ) : null}
            {unknownHost === "site" ? (
              <SwitchField
                id="unknown-hosts-certificate"
                label={m.unknown_hosts_default_certificate()}
                checked={certificate}
                onCheckedChange={setCertificate}
                className="self-start"
                testId="unknown-hosts-certificate"
              />
            ) : null}
          </div>
        ) : null}
        <SwitchField
          id="unknown-hosts-scan"
          label={m.unknown_hosts_scan()}
          checked={scan}
          onCheckedChange={toggleScan}
          className="self-start"
          testId="unknown-hosts-scan"
        />
        {scan ? (
          <div className="grid gap-4 animate-enter sm:grid-cols-2">
            <Field data-invalid={scanError || undefined}>
              <FieldLabel htmlFor="unknown-hosts-threshold">
                {m.unknown_hosts_scan_threshold()}
              </FieldLabel>
              <Input
                id="unknown-hosts-threshold"
                type="number"
                inputMode="numeric"
                min={SCAN_THRESHOLD.min}
                max={SCAN_THRESHOLD.max}
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
                data-testid="unknown-hosts-threshold"
              />
            </Field>
            <Field data-invalid={scanError || undefined}>
              <FieldLabel htmlFor="unknown-hosts-ban">{m.unknown_hosts_scan_ban()}</FieldLabel>
              <Input
                id="unknown-hosts-ban"
                type="number"
                inputMode="numeric"
                min={SCAN_BAN_SECONDS.min}
                max={SCAN_BAN_SECONDS.max}
                value={banSeconds}
                onChange={(event) => setBanSeconds(event.target.value)}
                data-testid="unknown-hosts-ban"
              />
            </Field>
            {scanError ? (
              <FieldError className="sm:col-span-2" data-testid="unknown-hosts-scan-invalid">
                {m.unknown_hosts_scan_invalid({
                  min: SCAN_THRESHOLD.min,
                  max: SCAN_THRESHOLD.max,
                  banMin: SCAN_BAN_SECONDS.min,
                  banMax: SCAN_BAN_SECONDS.max,
                })}
              </FieldError>
            ) : null}
          </div>
        ) : null}
        {locked ? (
          <SafetyNote data-testid="unknown-hosts-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        ) : null}
      </CardContent>
      <SaveBar
        dirty={dirty && !!normalized && !locked}
        pending={save.isPending}
        error={error}
        testId="unknown-hosts-save"
        errorTestId="unknown-hosts-error"
      />
    </form>
  );
}
