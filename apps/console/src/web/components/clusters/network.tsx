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
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Textarea } from "@/components/arc/textarea/textarea";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import { SafetyNote } from "@/components/safety-note";
import { ListInput, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, QueryView } from "@/components/states";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { defaultSiteChoices, loadedSites, nextSitePage, SITE_PAGE_SIZE } from "@/lib/default-site";
import { m } from "@/lib/i18n";
import { splitList } from "@/lib/lists";
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
      <Panel className="animate-enter" data-testid="listen-ports">
        <PanelHeader>
          <PanelTitle>{m.listen_ports_title()}</PanelTitle>
        </PanelHeader>
        <QueryView query={ports} frame={PanelContent}>
          {(data) => <ListenPortsForm key={JSON.stringify(data)} data={data} />}
        </QueryView>
      </Panel>
      <Panel className="animate-enter" style={{ animationDelay: "60ms" }} data-testid="client-ip">
        <PanelHeader>
          <PanelTitle>{m.client_ip_title()}</PanelTitle>
        </PanelHeader>
        <QueryView query={clientIp} frame={PanelContent}>
          {(data) => <ClientIpForm key={JSON.stringify(data.settings)} data={data} />}
        </QueryView>
      </Panel>
      <Panel
        className="animate-enter"
        style={{ animationDelay: "120ms" }}
        data-testid="unknown-hosts"
      >
        <PanelHeader>
          <PanelTitle>{m.unknown_hosts_title()}</PanelTitle>
        </PanelHeader>
        <QueryView query={unknownHosts} frame={PanelContent}>
          {(data) => <UnknownHostsForm key={JSON.stringify(data.settings)} data={data} />}
        </QueryView>
      </Panel>
    </div>
  );
}

const toNumbers = (list: string[]) => list.map((value) => Number(value));

const portsDraft = (data: ClusterListenPorts) => ({
  http: data.httpPorts.map(String),
  https: data.httpsPorts.map(String),
});

function ListenPortsForm({ data }: { data: ClusterListenPorts }) {
  const toInput = (draft: ReturnType<typeof portsDraft>) => ({
    clusterId: data.clusterId,
    httpPorts: toNumbers(draft.http),
    httpsPorts: toNumbers(draft.https),
  });
  const form = useSettingsForm({
    value: data,
    toDraft: portsDraft,
    toInput: (draft) => listenPortsInput.parse(toInput(draft)),
    mutation: {
      ...orpc.clusters.setListenPorts.mutationOptions(),
      meta: { invalidates: [orpc.clusters.listenPorts.key(), orpc.clusters.portPools.key()] },
    },
  });
  const { draft, set, dirty } = form;
  const initial = portsDraft(data);
  useUnsavedChanges(dirty);
  const parsed = listenPortsInput.safeParse(toInput(draft));
  // New ports wait for nodes that know them; removing ports always works.
  const locked = data.nodesWithout.length > 0;
  const grows =
    draft.http.some((p) => !initial.http.includes(p)) ||
    draft.https.some((p) => !initial.https.includes(p));
  return (
    <form
      className="flex flex-col gap-(--panel-pad)"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.success) void form.submit();
      }}
    >
      <PanelContent className="flex flex-col gap-4">
        <div
          className="flex flex-wrap items-center gap-2 text-sm"
          data-testid="listen-ports-always"
        >
          <span className="text-muted-foreground">{m.listen_ports_always()}</span>
          <Badge size="sm" tone="neutral" className="font-mono">
            80
          </Badge>
          <Badge size="sm" tone="neutral" className="font-mono">
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
              onChange={(http) => set({ http })}
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
              onChange={(https) => set({ https })}
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
      </PanelContent>
      {/* The save row of settings cards; the guard for unsaved changes stays on `dirty` above. */}
      <SaveBar
        dirty={dirty && parsed.success && !(locked && grows)}
        pending={form.pending}
        error={form.error}
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
  const save = useMutation({
    ...orpc.clusters.setClientIp.mutationOptions(),
    meta: { invalidates: [orpc.clusters.list.key()], success: m.common_saved },
  });
  const settings = {
    mode,
    trustedCidrs: mode === "header" ? splitList(cidrs) : [],
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
      className="flex flex-col gap-(--panel-pad)"
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
        } catch (e) {
          setError(errorMessage(e));
        }
      }}
    >
      <PanelContent className="flex flex-col gap-4">
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
      </PanelContent>
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

/** The default-site popup without sites to pick. */
function NoSite({ text }: { text: string }) {
  return (
    <p className="px-3 py-2 text-sm text-muted-foreground" data-testid="unknown-hosts-site-none">
      {text}
    </p>
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
  const save = useMutation({
    ...orpc.clusters.setUnknownHosts.mutationOptions(),
    meta: { success: m.common_saved },
  });
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
  // Matches come a page at a time (oldest site first); `more`: the next page can be loaded.
  const sites = useInfiniteQuery({
    ...orpc.sites.list.infiniteOptions({
      input: (page: number) => ({
        clusterId: data.clusterId,
        search: siteQuery || undefined,
        page,
        pageSize: SITE_PAGE_SIZE,
      }),
      initialPageParam: 1,
      getNextPageParam: nextSitePage,
    }),
    enabled: handsOver,
    placeholderData: keepPreviousData,
  });
  const loaded = loadedSites(sites.data?.pages);
  const { options, more } = defaultSiteChoices(loaded, {
    siteId,
    chosen,
    savedId: saved.defaultSiteId,
  });
  const pickSite = (value: string) => {
    setSiteId(value);
    const site = loaded?.items.find((item) => item.id === value);
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
      className="flex flex-col gap-(--panel-pad)"
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
        } catch (e) {
          setError(errorMessage(e));
        }
      }}
    >
      <PanelContent className="flex flex-col gap-4">
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
                onKeyDown={(event) => {
                  // Enter searches at once; it does not submit (and save) the settings.
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setSiteQuery(siteSearch.trim());
                  }
                }}
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
                empty={
                  <QueryView
                    query={sites}
                    loadingClassName="min-h-16"
                    error={() => <NoSite text={m.common_error_title()} />}
                  >
                    {() => <NoSite text={m.sites_no_match()} />}
                  </QueryView>
                }
              />
              {sites.isLoadingError ? (
                <ErrorState error={sites.error} onRetry={() => void sites.refetch()} />
              ) : null}
              {sites.isFetchNextPageError ? (
                <ErrorState error={sites.error} onRetry={() => void sites.fetchNextPage()} />
              ) : more && sites.hasNextPage && !sites.isPlaceholderData ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  disabled={sites.isFetchingNextPage}
                  onClick={() => void sites.fetchNextPage()}
                  data-testid="unknown-hosts-site-more"
                >
                  {sites.isFetchingNextPage ? <Spinner /> : null}
                  {m.unknown_hosts_site_more()}
                </Button>
              ) : null}
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
      </PanelContent>
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
