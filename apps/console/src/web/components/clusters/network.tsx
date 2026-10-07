import {
  CLIENT_IP_HEADERS,
  type ClientIpMode,
  type ClusterClientIp,
  type ClusterListenPorts,
  clientIpSettings,
  listenPortsInput,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { OptionSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { ListInput, SwitchField } from "@/components/site/fields";
import { QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** The cluster page's network tab: listener ports and the client address setting. */
export function ClusterNetwork({ clusterId }: { clusterId: string }) {
  const ports = useQuery(orpc.clusters.listenPorts.queryOptions({ input: { clusterId } }));
  const clientIp = useQuery(orpc.clusters.clientIp.queryOptions({ input: { clusterId } }));
  return (
    <div className="flex flex-col gap-4">
      <QueryView query={ports}>
        {(data) => <ListenPortsCard key={JSON.stringify(data)} data={data} />}
      </QueryView>
      <QueryView query={clientIp}>
        {(data) => <ClientIpCard key={JSON.stringify(data.settings)} data={data} />}
      </QueryView>
    </div>
  );
}

const toNumbers = (list: string[]) => list.map((value) => Number(value));

function ListenPortsCard({ data }: { data: ClusterListenPorts }) {
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
    <Card className="animate-enter" data-testid="listen-ports">
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
        <CardHeader>
          <CardTitle>{m.listen_ports_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            className="flex flex-wrap items-center gap-2 text-sm"
            data-testid="listen-ports-always"
          >
            <span className="text-muted-foreground">{m.listen_ports_always()}</span>
            <Badge variant="outline" className="font-mono">
              80
            </Badge>
            <Badge variant="outline" className="font-mono">
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
          {error ? (
            <FieldError className="animate-in fade-in" data-testid="listen-ports-error">
              {error}
            </FieldError>
          ) : null}
        </CardContent>
        <CardFooter className="justify-end border-t">
          <Button
            type="submit"
            disabled={!dirty || !parsed.success || (locked && grows) || save.isPending}
            data-testid="listen-ports-save"
          >
            {save.isPending ? <Spinner /> : null}
            {m.common_save()}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

const MODES: { value: ClientIpMode; label: () => string }[] = [
  { value: "direct", label: m.client_ip_mode_direct },
  { value: "proxy_protocol", label: m.client_ip_mode_proxy_protocol },
  { value: "header", label: m.client_ip_mode_header },
];

const CUSTOM = "custom";

function ClientIpCard({ data }: { data: ClusterClientIp }) {
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
    <Card className="animate-enter" style={{ animationDelay: "60ms" }} data-testid="client-ip">
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
        <CardHeader>
          <CardTitle>{m.client_ip_title()}</CardTitle>
        </CardHeader>
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
                  onChange={(event) => setCidrs(event.target.value)}
                  className="font-mono"
                  data-testid="client-ip-cidrs"
                />
                {cidrError ? (
                  <FieldError data-testid="client-ip-cidrs-invalid">
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
                  <Field>
                    <FieldLabel htmlFor="client-ip-header-name">
                      {m.client_ip_header_name()}
                    </FieldLabel>
                    <Input
                      id="client-ip-header-name"
                      value={custom}
                      placeholder="x-client-ip"
                      aria-invalid={headerError || undefined}
                      onChange={(event) => setCustom(event.target.value)}
                      className="font-mono"
                      data-testid="client-ip-header-name"
                    />
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
          {error ? (
            <FieldError className="animate-in fade-in" data-testid="client-ip-error">
              {error}
            </FieldError>
          ) : null}
        </CardContent>
        <CardFooter className="justify-end border-t">
          <Button
            type="submit"
            disabled={!dirty || !normalized || locked || save.isPending}
            data-testid="client-ip-save"
          >
            {save.isPending ? <Spinner /> : null}
            {m.common_save()}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
