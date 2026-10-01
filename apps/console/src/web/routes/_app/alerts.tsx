import {
  type AlertChannelConfig,
  type AlertEventKind,
  type AlertKind,
  type AlertPolicy,
  alertChannelConfig,
  alertKind,
  alertPolicy,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateTime, m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

type EditableChannel = {
  id: string;
  name: string;
  kind: string;
  platform: boolean;
  locale: "zh-CN" | "en";
};
type Channel = EditableChannel & { enabled: boolean; lastError?: string | null };

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
    config_rule_invalid: m.alert_kind_config_rule_invalid,
    dns_mass_removal_blocked: m.alert_kind_dns_mass_removal_blocked,
    scheduling_action: m.alert_kind_scheduling_action,
  })[kind]();
const kindLabel = (kind: AlertChannelConfig["kind"]) =>
  ({
    webhook: m.alert_channel_webhook,
    email: m.alert_channel_email,
    dingtalk: m.alert_channel_dingtalk,
    wecom: m.alert_channel_wecom,
    telegram: m.alert_channel_telegram,
  })[kind]();

/** Channels, the sites subscribed to them, recent alerts and the thresholds, on one page. */
function AlertsPage() {
  const channels = useQuery(
    orpc.alerts.channels.queryOptions({ refetchInterval: 15000, meta: { background: true } }),
  );
  return (
    <Page title={m.alert_title()}>
      <ChannelsCard
        channels={channels.data}
        pending={channels.isPending}
        error={channels.error}
        onRetry={() => void channels.refetch()}
      />
      <SubscriptionsCard channels={(channels.data ?? []).filter((c) => c.enabled)} />
      <EventsCard />
      <PolicyCard />
    </Page>
  );
}

function ChannelsCard({
  channels,
  pending,
  error,
  onRetry,
}: {
  channels: Channel[] | undefined;
  pending: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const queries = useQueryClient(),
    [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<EditableChannel | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: {
      action: "toggle" | "test" | "delete";
      id: string;
      enabled?: boolean;
    }) => {
      if (input.action === "test") await client.alerts.testChannel({ id: input.id });
      else if (input.action === "delete") await client.alerts.deleteChannel({ id: input.id });
      else await client.alerts.updateChannel({ id: input.id, enabled: input.enabled });
      await queries.invalidateQueries();
    },
  });
  const act = async (action: "toggle" | "test" | "delete", id: string, enabled?: boolean) => {
    try {
      await mutation.mutateAsync({ action, id, enabled });
      toast.success(m.common_saved());
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card className="animate-enter">
      <CardHeader>
        <CardTitle>{m.alert_channels_title()}</CardTitle>
        <CardAction>
          <Button size="sm" onClick={() => setCreating(true)} data-testid="alert-channel-create">
            {m.alert_channel_add()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {pending ? (
          <LoadingState />
        ) : error || !channels ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : !channels.length ? (
          <EmptyState title={m.alert_no_channels()} />
        ) : (
          <ul className="divide-y">
            {channels.map((channel) => (
              <li
                key={channel.id}
                className="flex flex-wrap items-center gap-3 py-3"
                data-testid="alert-channel"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-all text-sm font-medium">{channel.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {kindLabel(channel.kind as AlertChannelConfig["kind"])}
                  </p>
                </div>
                <Badge variant="outline">{channel.enabled ? m.rules_on() : m.rules_off()}</Badge>
                {channel.platform ? (
                  <Badge variant="secondary">{m.alert_platform_scope()}</Badge>
                ) : null}
                {channel.lastError ? (
                  <Badge variant="destructive">{m.error_alert_send_failed()}</Badge>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setEditing(channel)}>
                  {m.common_edit()}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => void act("test", channel.id)}
                >
                  {m.alert_test_send()}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => void act("toggle", channel.id, !channel.enabled)}
                >
                  {channel.enabled ? m.alert_disable() : m.alert_enable()}
                </Button>
                <ConfirmDialog
                  title={m.common_delete()}
                  destructive
                  trigger={
                    <Button variant="destructive" size="sm" disabled={mutation.isPending}>
                      {m.common_delete()}
                    </Button>
                  }
                  onConfirm={() => act("delete", channel.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {creating || editing ? (
        <ChannelDialog
          initial={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      ) : null}
    </Card>
  );
}

/** Site alerts go to the channels the site is subscribed to (and to every-alert channels). */
function SubscriptionsCard({ channels }: { channels: { id: string; name: string }[] }) {
  const subscriptions = useQuery(orpc.alerts.subscriptions.queryOptions());
  const [creating, setCreating] = React.useState(false);
  const queries = useQueryClient();
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <CardHeader>
        <CardTitle>{m.alert_subscriptions_title()}</CardTitle>
        <CardAction>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreating(true)}
            disabled={!channels.length}
            data-testid="alert-subscribe"
          >
            {m.alert_subscribe()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {subscriptions.isPending ? (
          <LoadingState />
        ) : subscriptions.isError ? (
          <ErrorState error={subscriptions.error} onRetry={() => void subscriptions.refetch()} />
        ) : !subscriptions.data.length ? (
          <EmptyState
            title={channels.length ? m.alert_no_subscriptions() : m.alert_no_available_channels()}
          />
        ) : (
          <ul className="divide-y">
            {subscriptions.data.map((sub) => (
              <li
                key={sub.id}
                className="flex flex-wrap items-center gap-3 py-3"
                data-testid="alert-subscription"
              >
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
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {creating ? (
        <SubscriptionDialog channels={channels} onClose={() => setCreating(false)} />
      ) : null}
    </Card>
  );
}

function EventsCard() {
  const events = useQuery(
    orpc.alerts.events.queryOptions({
      input: {},
      refetchInterval: 30000,
      meta: { background: true },
    }),
  );
  return (
    <Card className="animate-enter" style={{ animationDelay: "120ms" }}>
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
  );
}

function PolicyCard() {
  const policy = useQuery(orpc.alerts.policy.queryOptions());
  return policy.isPending ? (
    <LoadingState />
  ) : policy.isError ? (
    <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />
  ) : (
    <PolicyEditor key={JSON.stringify(policy.data)} initial={policy.data} />
  );
}

function PolicyEditor({ initial }: { initial: AlertPolicy }) {
  const [form, setForm] = React.useState(initial),
    [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient(),
    mutation = useMutation(orpc.alerts.setPolicy.mutationOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "180ms" }}>
      <CardHeader>
        <CardTitle>{m.alert_policy_title()}</CardTitle>
      </CardHeader>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const parsed = alertPolicy.safeParse(form);
            if (!parsed.success) {
              setError(m.alert_check_fields());
              return;
            }
            await mutation.mutateAsync(parsed.data);
            await queries.invalidateQueries();
            toast.success(m.common_saved());
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["nodeOfflineSeconds", m.alert_offline_seconds(), 45, 3600],
              ["certificateHours", m.alert_certificate_hours(), 1, 720],
              ["minimumRequests", m.alert_minimum_requests(), 1, 1000000],
              ["windowMinutes", m.alert_window_minutes(), 1, 60],
            ] as const
          ).map(([key, label, min, max]) => (
            <NumberField
              key={key}
              id={`alert-${key}`}
              label={label}
              value={String(form[key])}
              min={min}
              max={max}
              onChange={(value) => setForm({ ...form, [key]: Number(value) })}
            />
          ))}
          <NumberField
            id="alert-ratio"
            label={m.alert_error_ratio()}
            value={String(Math.round(form.errorRatio * 100))}
            min={1}
            max={100}
            onChange={(value) => setForm({ ...form, errorRatio: Number(value) / 100 })}
          />
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(form) !== JSON.stringify(initial)}
          pending={mutation.isPending}
          error={error}
          testId="alert-policy-save"
        />
      </form>
    </Card>
  );
}
function ChannelDialog({ onClose, initial }: { onClose: () => void; initial?: EditableChannel }) {
  const [kind, setKind] = React.useState<AlertChannelConfig["kind"]>(
      (initial?.kind as AlertChannelConfig["kind"]) ?? "webhook",
    ),
    [platform, setPlatform] = React.useState(initial?.platform ?? false),
    [locale, setLocale] = React.useState<string>(initial?.locale ?? "zh-CN");
  const [replaceConfig, setReplaceConfig] = React.useState(!initial);
  const update = useMutation(orpc.alerts.updateChannel.mutationOptions());
  const queries = useQueryClient(),
    mutation = useMutation(orpc.alerts.createChannel.mutationOptions());
  const fields =
    kind === "email"
      ? ["to"]
      : kind === "telegram"
        ? ["token", "chatId"]
        : kind === "webhook"
          ? ["url", "bearer"]
          : kind === "dingtalk"
            ? ["url", "secret"]
            : ["url"];
  const labels: Record<string, () => string> = {
    to: m.alert_recipients,
    token: m.alert_bot_token,
    chatId: m.alert_chat_id,
    url: m.alert_endpoint,
    bearer: m.alert_bearer,
    secret: m.alert_signing_secret,
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={initial ? m.common_edit() : m.alert_channel_add()}
      submitLabel={initial ? m.common_save() : m.common_create()}
      submitTestId="alert-channel-submit"
      onSubmit={async (data) => {
        let config: AlertChannelConfig | undefined;
        if (replaceConfig) {
          const values: Record<string, unknown> = { kind };
          for (const field of fields) {
            const value = String(data.get(field) ?? "");
            if (field === "to") values[field] = value.split(/[,\s]+/).filter(Boolean);
            else if (value) values[field] = value;
          }
          const parsed = alertChannelConfig.safeParse(values);
          if (!parsed.success) throw new Error(m.alert_check_fields());
          config = parsed.data;
        }
        const common = {
          name: String(data.get("channel-name")),
          platform,
          locale: locale as "zh-CN" | "en",
        };
        if (initial) await update.mutateAsync({ id: initial.id, ...common, config });
        else if (config) await mutation.mutateAsync({ ...common, config });
        await queries.invalidateQueries();
        onClose();
      }}
    >
      <Field>
        <FieldLabel htmlFor="channel-name">{m.cert_name()}</FieldLabel>
        <Input
          id="channel-name"
          name="channel-name"
          required
          maxLength={100}
          defaultValue={initial?.name}
        />
      </Field>
      {initial ? (
        <SwitchField
          id="channel-replace-config"
          label={m.alert_rotate_credentials()}
          checked={replaceConfig}
          onCheckedChange={setReplaceConfig}
        />
      ) : null}
      <FormSelect
        id="channel-kind"
        disabled={!replaceConfig}
        label={m.alert_channel_kind()}
        value={kind}
        onChange={(value) => setKind(value as typeof kind)}
        options={(["webhook", "email", "dingtalk", "wecom", "telegram"] as const).map((kind) => ({
          value: kind,
          label: kindLabel(kind),
        }))}
      />
      {replaceConfig &&
        fields.map((field) => (
          <Field key={`${kind}-${field}`}>
            <FieldLabel htmlFor={`channel-${field}`}>{labels[field]?.()}</FieldLabel>
            <Input
              id={`channel-${field}`}
              name={field}
              required={!["bearer", "secret"].includes(field)}
              type={["token", "bearer", "secret"].includes(field) ? "password" : "text"}
              autoComplete="off"
            />
          </Field>
        ))}
      <FormSelect
        id="channel-locale"
        label={m.alert_language()}
        value={locale}
        onChange={setLocale}
        options={[
          { value: "zh-CN", label: m.language_zh_cn() },
          { value: "en", label: m.language_en() },
        ]}
      />
      <SwitchField
        id="channel-platform"
        label={m.alert_platform_scope()}
        checked={platform}
        onCheckedChange={setPlatform}
      />
    </FormDialog>
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
