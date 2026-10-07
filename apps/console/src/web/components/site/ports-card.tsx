import type { Site } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { SafetyNote } from "@/components/safety-note";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** Checkboxes for a set of values, one per option. */
export function CheckboxList<T extends string | number>({
  id,
  legend,
  options,
  value,
  onChange,
  disabled,
  testId,
}: {
  id: string;
  legend: string;
  options: { value: T; label: string; disabled?: boolean }[];
  value: T[];
  onChange: (value: T[]) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <FieldSet className="gap-2" data-testid={testId}>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {options.map((option) => {
          const key = `${id}-${option.value}`;
          const checked = value.includes(option.value);
          return (
            <Field
              key={key}
              orientation="horizontal"
              className="w-auto"
              data-disabled={disabled || option.disabled || undefined}
            >
              <Checkbox
                id={key}
                checked={checked}
                disabled={disabled || option.disabled}
                onCheckedChange={(next) =>
                  onChange(
                    next ? [...value, option.value] : value.filter((v) => v !== option.value),
                  )
                }
                data-testid={`${testId}-${option.value}`}
              />
              <FieldLabel htmlFor={key} className="font-mono">
                {option.label}
              </FieldLabel>
            </Field>
          );
        })}
      </div>
    </FieldSet>
  );
}

const sorted = (ports: number[]) => [...new Set(ports)].sort((a, b) => a - b);

/** The listener ports a site is served on (the site's domains tab). */
export function SitePortsCard({ site }: { site: Site }) {
  const ports = useQuery(
    orpc.clusters.listenPorts.queryOptions({ input: { clusterId: site.clusterId } }),
  );
  const https = useQuery(orpc.https.get.queryOptions({ input: { id: site.id } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  return (
    <QueryView query={combineQueries(ports, https, features)}>
      {([cluster, tls, available]) => (
        <PortsEditor
          key={JSON.stringify(site.ports)}
          site={site}
          httpOptions={sorted([80, ...cluster.httpPorts, ...site.ports.http])}
          httpsOptions={sorted([443, ...cluster.httpsPorts, ...site.ports.https])}
          certificate={!!tls.certificateId}
          extraAvailable={available.edgePorts.available}
        />
      )}
    </QueryView>
  );
}

function PortsEditor({
  site,
  httpOptions,
  httpsOptions,
  certificate,
  extraAvailable,
}: {
  site: Site;
  httpOptions: number[];
  httpsOptions: number[];
  certificate: boolean;
  extraAvailable: boolean;
}) {
  const [http, setHttp] = React.useState(site.ports.http);
  const [https, setHttps] = React.useState(site.ports.https);
  const { save, error, pending } = useSaveSite(site.id);
  const next = { http: sorted(http), https: sorted(https) };
  const dirty = JSON.stringify(next) !== JSON.stringify(site.ports);
  const empty = next.http.length === 0 && (!certificate || next.https.length === 0);
  // Ports besides 80 and 443 wait for nodes that know them, unless already chosen.
  const locked = (port: number, defaults: number) =>
    !extraAvailable &&
    port !== defaults &&
    !site.ports.http.concat(site.ports.https).includes(port);
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }} data-testid="site-ports">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!empty) await save({ ports: next });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_ports_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CheckboxList
            id="site-port-http"
            legend={m.site_ports_http()}
            options={httpOptions.map((port) => ({
              value: port,
              label: String(port),
              disabled: locked(port, 80),
            }))}
            value={http}
            onChange={setHttp}
            testId="site-ports-http"
          />
          <CheckboxList
            id="site-port-https"
            legend={m.site_ports_https()}
            options={httpsOptions.map((port) => ({
              value: port,
              label: String(port),
              disabled: locked(port, 443) || (!certificate && port !== 443),
            }))}
            value={https}
            onChange={setHttps}
            testId="site-ports-https"
          />
          {certificate ? null : (
            <SafetyNote data-testid="site-ports-https-note">
              {m.site_ports_https_needs_cert()}
            </SafetyNote>
          )}
          {extraAvailable ? null : (
            <SafetyNote data-testid="site-ports-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          )}
        </CardContent>
        <SaveBar
          dirty={dirty && !empty}
          pending={pending}
          error={empty ? m.site_ports_empty() : error}
          testId="site-ports-save"
        />
      </form>
    </Card>
  );
}
