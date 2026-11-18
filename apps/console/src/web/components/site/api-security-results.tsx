import { apiPath, type ApiSecurityResults as Results } from "@edgeweir/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { FormDialog } from "@/components/form-dialog";
import { Field, FieldLabel } from "@/components/layout/form";
import {
  Panel,
  PanelContent,
  PanelFooter,
  PanelHeader,
  PanelTitle,
} from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { Pager } from "@/components/pager";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, QueryView } from "@/components/states";
import { TimeAgo } from "@/components/time-ago";
import { apiCheckLabel, apiModeLabel, apiSourceLabel } from "@/lib/api-security-labels";
import { formatDateTime, formatNumber, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const PAGE_SIZE = 25;

export function ApiSecurityResults({ siteId }: { siteId: string }) {
  const results = useQuery(orpc.apiSecurity.results.queryOptions({ input: { id: siteId } }));
  return (
    <>
      <Panel data-testid="api-discovery-results">
        <PanelHeader>
          <PanelTitle>{m.api_security_discovered_endpoints()}</PanelTitle>
          <Button
            variant="secondary"
            size="sm"
            disabled={results.isFetching}
            onClick={() => void results.refetch()}
            data-testid="api-results-refresh"
          >
            {results.isFetching ? <Spinner /> : null}
            {m.api_security_refresh()}
          </Button>
        </PanelHeader>
        <QueryView query={results} frame={PanelContent}>
          {(data) => <EndpointResults siteId={siteId} data={data} />}
        </QueryView>
      </Panel>
      <Panel data-testid="api-observation-results">
        <PanelHeader>
          <PanelTitle>{m.api_security_observations()}</PanelTitle>
        </PanelHeader>
        <QueryView query={results} frame={PanelContent}>
          {(data) => <ObservationResults events={data.events} />}
        </QueryView>
      </Panel>
    </>
  );
}

function EndpointResults({ siteId, data }: { siteId: string; data: Results }) {
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<Results["endpoints"][number] | null>(null);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(data.endpoints.length / PAGE_SIZE)));
  return (
    <>
      <PanelContent className="flex flex-col gap-3">
        {data.unsupportedNodes > 0 ? (
          <SafetyNote>
            {m.api_security_unsupported_nodes({ count: formatNumber(data.unsupportedNodes) })}
          </SafetyNote>
        ) : null}
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-dense">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{m.api_security_sampling()}</dt>
            <dd className="readout">{formatPercent(data.sampleRate / 100)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{m.api_security_retention()}</dt>
            <dd className="readout">
              {m.api_security_retention_days({ days: formatNumber(data.retentionDays) })}
            </dd>
          </div>
        </dl>
        {data.endpoints.length === 0 ? (
          <EmptyState title={m.api_security_discovery_empty()} compact />
        ) : null}
      </PanelContent>
      {data.endpoints.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.api_security_method()}</TableHead>
              <TableHead>{m.api_security_path()}</TableHead>
              <TableHead>{m.api_security_source()}</TableHead>
              <TableHead>{m.api_security_first_seen()}</TableHead>
              <TableHead>{m.api_security_last_seen()}</TableHead>
              <TableHead>{m.api_security_sampled_requests()}</TableHead>
              <TableHead>{m.api_security_sampled_violations()}</TableHead>
              <TableHead>{m.api_security_confirmation()}</TableHead>
              <TableHead>
                <span className="sr-only">{m.api_security_actions()}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.endpoints
              .slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
              .map((endpoint) => (
                <TableRow key={endpoint.id} data-testid="api-discovered-endpoint">
                  <TableCell className="font-mono">{endpoint.method}</TableCell>
                  <TableCell className="max-w-80 truncate font-mono" title={endpoint.path}>
                    {endpoint.path}
                  </TableCell>
                  <TableCell>{apiSourceLabel(endpoint.source)}</TableCell>
                  <TableCell>
                    <TimeAgo at={endpoint.firstSeen} />
                  </TableCell>
                  <TableCell>
                    <TimeAgo at={endpoint.lastSeen} />
                  </TableCell>
                  <TableCell className="readout">
                    {formatNumber(endpoint.sampledRequests)}
                  </TableCell>
                  <TableCell className="readout">{formatNumber(endpoint.violations)}</TableCell>
                  <TableCell>
                    {endpoint.confirmed ? m.api_security_confirmed() : m.api_security_unconfirmed()}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(endpoint)}
                      aria-label={m.api_security_confirm_path({ path: endpoint.path })}
                      data-testid="api-endpoint-confirm"
                    >
                      {endpoint.confirmed ? m.api_security_correct() : m.common_confirm()}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      ) : null}
      {data.endpoints.length > PAGE_SIZE ? (
        <PanelFooter>
          <Pager
            page={currentPage}
            pageSize={PAGE_SIZE}
            total={data.endpoints.length}
            onPageChange={setPage}
          />
        </PanelFooter>
      ) : null}
      {editing ? (
        <ConfirmEndpointDialog
          key={editing.id}
          siteId={siteId}
          endpoint={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function ConfirmEndpointDialog({
  siteId,
  endpoint,
  onClose,
}: {
  siteId: string;
  endpoint: Results["endpoints"][number];
  onClose: () => void;
}) {
  const [path, setPath] = React.useState(endpoint.path);
  const confirm = useMutation({
    ...orpc.apiSecurity.confirmEndpoint.mutationOptions(),
    meta: { invalidates: [orpc.apiSecurity.results.key()], success: m.common_saved },
  });
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={m.api_security_confirm_endpoint()}
      submitLabel={m.common_confirm()}
      submitTestId="api-endpoint-confirm-submit"
      onSubmit={async () => {
        if (!apiPath.safeParse(path).success)
          throw new Error(m.common_check_field({ field: m.api_security_path() }));
        await confirm.mutateAsync({ id: siteId, endpointId: endpoint.id, path });
        onClose();
      }}
    >
      <SafetyNote>{m.api_security_confirm_discovery_only()}</SafetyNote>
      <Field>
        <FieldLabel htmlFor="api-endpoint-path">{m.api_security_path()}</FieldLabel>
        <Input
          id="api-endpoint-path"
          value={path}
          required
          maxLength={512}
          spellCheck={false}
          className="font-mono"
          disabled={confirm.isPending}
          data-testid="api-endpoint-path"
          onChange={(event) => setPath(event.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

function ObservationResults({ events }: { events: Results["events"] }) {
  const [page, setPage] = React.useState(1);
  type ObservationRow = {
    event: Results["events"][number];
    issue: Results["events"][number]["detail"]["issues"][number] | null;
    key: string;
  };
  const rows = events.flatMap<ObservationRow>((event, index) =>
    event.detail.issues.length
      ? event.detail.issues.map((issue, issueIndex) => ({
          event,
          issue,
          key: `${index}-${issueIndex}`,
        }))
      : [{ event, issue: null, key: `${index}-none` }],
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE)));
  if (!rows.length)
    return (
      <PanelContent>
        <EmptyState title={m.api_security_observations_empty()} compact />
      </PanelContent>
    );
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{m.api_security_time()}</TableHead>
            <TableHead>{m.api_security_request_id()}</TableHead>
            <TableHead>{m.api_security_method()}</TableHead>
            <TableHead>{m.api_security_path()}</TableHead>
            <TableHead>{m.api_security_check()}</TableHead>
            <TableHead>{m.api_security_code()}</TableHead>
            <TableHead>{m.api_security_mode()}</TableHead>
            <TableHead>{m.api_security_status()}</TableHead>
            <TableHead>{m.api_security_exceptions()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows
            .slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
            .map(({ event, issue, key }) => (
              <TableRow key={key} data-testid="api-observation">
                <TableCell>{formatDateTime(event.time)}</TableCell>
                <TableCell className="max-w-60 truncate font-mono" title={event.requestId}>
                  {event.requestId || "—"}
                </TableCell>
                <TableCell className="font-mono">{event.method}</TableCell>
                <TableCell className="max-w-80 truncate font-mono" title={event.detail.template}>
                  {event.detail.template}
                </TableCell>
                <TableCell>{issue ? apiCheckLabel(issue.check) : "—"}</TableCell>
                <TableCell className="font-mono">{issue?.code ?? "—"}</TableCell>
                <TableCell>{issue ? apiModeLabel(issue.mode) : "—"}</TableCell>
                <TableCell className="readout">{event.status}</TableCell>
                <TableCell className="readout">
                  {formatNumber(event.detail.exceptionIds.length)}
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
      {rows.length > PAGE_SIZE ? (
        <PanelFooter>
          <Pager
            page={currentPage}
            pageSize={PAGE_SIZE}
            total={rows.length}
            onPageChange={setPage}
          />
        </PanelFooter>
      ) : null}
    </>
  );
}
