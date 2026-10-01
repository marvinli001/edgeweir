import { type AlertEventKind, type AlertKind, alertKind } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { SwitchField } from "@/components/site/fields";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateTime, m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
export const Route = createFileRoute("/_app/alerts")({ component: AlertsPage });
const label = (kind: AlertEventKind) =>
  ({
    node_offline: m.alert_kind_node_offline,
    certificate_expiring: m.alert_kind_certificate_expiring,
    origin_unavailable: m.alert_kind_origin_unavailable,
    high_5xx: m.alert_kind_high_5xx,
    cc_mitigation: m.alert_kind_cc_mitigation,
    config_rollout_failed: m.alert_kind_config_rollout_failed,
    config_rollout_no_canary: m.alert_kind_config_rollout_no_canary,
    dns_mass_removal_blocked: m.alert_kind_dns_mass_removal_blocked,
  })[kind]();
function AlertsPage() {
  const subscriptions = useQuery(orpc.alerts.subscriptions.queryOptions()),
    channels = useQuery(orpc.alerts.channels.queryOptions()),
    events = useQuery(
      orpc.alerts.events.queryOptions({
        input: {},
        refetchInterval: 30000,
        meta: { background: true },
      }),
    );
  const [creating, setCreating] = React.useState(false);
  const queries = useQueryClient();
  const usable = (channels.data ?? []).filter((c) => c.enabled);
  return (
    <Page
      title={m.alert_title()}
      actions={
        <Button
          onClick={() => setCreating(true)}
          disabled={!usable.length}
          data-testid="alert-subscribe"
        >
          {m.alert_subscribe()}
        </Button>
      }
    >
      {subscriptions.isPending ? (
        <LoadingState />
      ) : subscriptions.isError ? (
        <ErrorState error={subscriptions.error} onRetry={() => void subscriptions.refetch()} />
      ) : !subscriptions.data.length ? (
        <EmptyState
          title={usable.length ? m.alert_no_subscriptions() : m.alert_no_available_channels()}
        />
      ) : (
        subscriptions.data.map((sub) => (
          <Card key={sub.id} className="animate-enter">
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm font-medium">{sub.siteName}</p>
                <span className="text-xs text-muted-foreground">{sub.channelName}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {sub.kinds.map((kind) => (
                  <Badge key={kind} variant="outline">
                    {label(kind)}
                  </Badge>
                ))}
              </div>
              <ConfirmDialog
                title={m.alert_unsubscribe()}
                trigger={
                  <Button size="sm" variant="outline">
                    {m.alert_unsubscribe()}
                  </Button>
                }
                onConfirm={async () => {
                  try {
                    await client.alerts.unsubscribe({ id: sub.id });
                    await queries.invalidateQueries();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              />
            </CardContent>
          </Card>
        ))
      )}
      {channels.isError ? (
        <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{m.alert_recent_events()}</CardTitle>
        </CardHeader>
        <CardContent>
          {events.isPending ? (
            <LoadingState />
          ) : events.isError ? (
            <ErrorState error={events.error} onRetry={() => void events.refetch()} />
          ) : !events.data.length ? (
            <EmptyState title={m.alert_no_events()} />
          ) : (
            <ul className="divide-y">
              {events.data.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
                  <span className="w-full min-w-0 break-words sm:w-auto sm:flex-1">
                    {event.siteName}
                  </span>
                  <Badge variant="outline">{label(event.kind)}</Badge>
                  <Badge variant="secondary">
                    {event.status === "resolved" ? m.alert_recovered() : m.alert_firing()}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(event.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {creating ? (
        <SubscriptionDialog channels={usable} onClose={() => setCreating(false)} />
      ) : null}
    </Page>
  );
}
function SubscriptionDialog({
  channels,
  onClose,
}: {
  channels: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [search, setSearch] = React.useState(""),
    [siteId, setSiteId] = React.useState(""),
    [selectedName, setSelectedName] = React.useState(""),
    [channelId, setChannelId] = React.useState(channels[0]?.id ?? ""),
    [kinds, setKinds] = React.useState<AlertKind[]>([...alertKind.options]);
  const sites = useQuery(orpc.sites.list.queryOptions({ input: { search, pageSize: 100 } }));
  const queries = useQueryClient(),
    mutation = useMutation(orpc.alerts.subscribe.mutationOptions());
  const choices = (sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }));
  if (siteId && !choices.some((c) => c.value === siteId))
    choices.unshift({ value: siteId, label: selectedName });
  return (
    <FormDialog
      open
      title={m.alert_subscribe()}
      submitLabel={m.common_save()}
      submitTestId="alert-subscription-submit"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onSubmit={async () => {
        if (!siteId || !channelId || !kinds.length) throw new Error(m.alert_check_fields());
        await mutation.mutateAsync({ siteId, channelId, kinds });
        await queries.invalidateQueries();
        onClose();
      }}
    >
      <Field>
        <FieldLabel htmlFor="alert-site-search">{m.alert_site_search()}</FieldLabel>
        <Input id="alert-site-search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      {sites.isPending ? (
        <LoadingState />
      ) : sites.isError ? (
        <ErrorState error={sites.error} onRetry={() => void sites.refetch()} />
      ) : (
        <FormSelect
          id="alert-site"
          label={m.nav_sites()}
          value={siteId}
          options={choices}
          onChange={(id) => {
            setSiteId(id);
            setSelectedName(choices.find((c) => c.value === id)?.label ?? "");
          }}
        />
      )}
      <FormSelect
        id="alert-channel"
        label={m.alert_channel_label()}
        value={channelId}
        options={channels.map((c) => ({ value: c.id, label: c.name }))}
        onChange={setChannelId}
      />
      {alertKind.options.map((kind) => (
        <SwitchField
          key={kind}
          id={`subscribe-${kind}`}
          label={label(kind)}
          checked={kinds.includes(kind)}
          onCheckedChange={(enabled) =>
            setKinds(enabled ? [...kinds, kind] : kinds.filter((k) => k !== kind))
          }
        />
      ))}
    </FormDialog>
  );
}
