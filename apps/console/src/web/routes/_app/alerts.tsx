import {
  type AlertChannelConfig,
  type AlertEventKind,
  type AlertKind,
  type AlertPolicy,
  alertChannelConfig,
  alertKind,
  alertPolicy,
} from "@edgeweir/contract";
import { Mail01Icon, Message01Icon, TelegramIcon, WebhookIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { enterDelay, Page } from "@/components/page";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { SiteMultiSelect } from "@/components/site-multi-select";
import { SmtpSettings } from "@/components/smtp-settings";
import { EmptyState, type QueryResult, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
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
const KIND_ICON: Record<AlertChannelConfig["kind"], typeof WebhookIcon> = {
  webhook: WebhookIcon,
  email: Mail01Icon,
  dingtalk: Message01Icon,
  wecom: Message01Icon,
  telegram: TelegramIcon,
};

/** Channels and their mail server, the sites subscribed to them, recent alerts and the thresholds, on one page. */
function AlertsPage() {
  const channels = useQuery(
    orpc.alerts.channels.queryOptions({ refetchInterval: 15000, meta: { background: true } }),
  );
  return (
    <Page title={m.alert_title()}>
      <ChannelsCard channels={channels} />
      <SmtpSettings className="animate-enter" style={{ animationDelay: "60ms" }} />
      <SubscriptionsCard channels={(channels.data ?? []).filter((c) => c.enabled)} />
      <EventsCard />
      <PolicyCard />
    </Page>
  );
}

function ChannelsCard({ channels }: { channels: QueryResult<Channel[]> }) {
  const queries = useQueryClient();
  const dialog = useDialogState<EditableChannel | "new">();
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
  const run = async (action: "toggle" | "test" | "delete", id: string, enabled?: boolean) => {
    await mutation.mutateAsync({ action, id, enabled });
    toast.success(m.common_saved());
  };
  const act = (action: "toggle" | "test", id: string, enabled?: boolean) =>
    run(action, id, enabled).catch((e: unknown) => toast.error(errorMessage(e)));
  return (
    <Card className="animate-enter">
      <CardHeader>
        <CardTitle>{m.alert_channels_title()}</CardTitle>
        <CardAction>
          <Button size="sm" onClick={() => dialog.show("new")} data-testid="alert-channel-create">
            {m.alert_channel_add()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <QueryView query={channels} empty={<EmptyState title={m.alert_no_channels()} />}>
          {(list) => (
            <ul className="divide-y">
              {list.map((channel, index) => (
                <li
                  key={channel.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 py-3 animate-enter first:pt-0 last:pb-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                  style={enterDelay(index)}
                  data-testid="alert-channel"
                >
                  <span className="grid size-9 place-items-center rounded-xl text-muted-foreground sunk-well">
                    <HugeiconsIcon
                      icon={KIND_ICON[channel.kind as AlertChannelConfig["kind"]] ?? WebhookIcon}
                      strokeWidth={2}
                      className="size-4"
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <p className="min-w-0 font-medium [overflow-wrap:anywhere]">{channel.name}</p>
                      <StatusDot tone={channel.enabled ? "good" : "idle"}>
                        <span className="text-xs text-muted-foreground">
                          {channel.enabled ? m.rules_on() : m.rules_off()}
                        </span>
                      </StatusDot>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        {kindLabel(channel.kind as AlertChannelConfig["kind"])}
                      </span>
                      {channel.platform ? (
                        <Badge variant="secondary">{m.alert_platform_scope()}</Badge>
                      ) : null}
                      {channel.lastError ? (
                        <Badge variant="destructive">
                          {channel.lastError === "alert_smtp_not_configured"
                            ? m.error_alert_smtp_not_configured()
                            : m.error_alert_send_failed()}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-1 sm:justify-end">
                    <Button size="sm" variant="outline" onClick={() => dialog.show(channel)}>
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
                      onConfirm={() => run("delete", channel.id)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </CardContent>
      {dialog.value ? (
        <ChannelDialog
          key={dialog.key}
          initial={dialog.value === "new" ? undefined : dialog.value}
          open={dialog.open}
          onOpenChange={dialog.onOpenChange}
        />
      ) : null}
    </Card>
  );
}

type Subscription = {
  id: string;
  channelId: string;
  channelName: string;
  kinds: AlertKind[];
  enabled: boolean;
  allSites: boolean;
  sites: { id: string; name: string }[];
};
/** Site badges a subscription row shows before "+N". */
const SITE_BADGES = 6;

/** Site alerts go to the channel a subscription covers them with (and to every-alert channels). */
function SubscriptionsCard({ channels }: { channels: { id: string; name: string }[] }) {
  const subscriptions = useQuery(orpc.alerts.subscriptions.queryOptions());
  const dialog = useDialogState<Subscription | "new">();
  const queries = useQueryClient();
  // One subscription per channel: the others are edited from their row.
  const available = channels.filter(
    (c) => !subscriptions.data?.some((sub) => sub.channelId === c.id),
  );
  return (
    <Card className="animate-enter" style={{ animationDelay: "120ms" }}>
      <CardHeader>
        <CardTitle>{m.alert_subscriptions_title()}</CardTitle>
        <CardAction>
          <Button
            size="sm"
            variant="outline"
            onClick={() => dialog.show("new")}
            disabled={!subscriptions.data || !available.length}
            data-testid="alert-subscribe"
          >
            {m.alert_subscribe()}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <QueryView
          query={subscriptions}
          empty={
            <EmptyState
              title={channels.length ? m.alert_no_subscriptions() : m.alert_no_available_channels()}
            />
          }
        >
          {(list) => (
            <ul className="divide-y">
              {list.map((sub, index) => (
                <li
                  key={sub.id}
                  className="grid grid-cols-1 items-center gap-x-4 gap-y-2.5 py-3 animate-enter first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                  style={enterDelay(index)}
                  data-testid="alert-subscription"
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <p className="min-w-0 font-medium [overflow-wrap:anywhere]">
                        {sub.channelName}
                      </p>
                      {sub.enabled ? null : (
                        <StatusDot tone="idle">
                          <span className="text-xs text-muted-foreground">{m.rules_off()}</span>
                        </StatusDot>
                      )}
                    </div>
                    {/* Sites in a well (machine names), the alert kinds as chips under them. */}
                    <div
                      className="flex flex-wrap gap-1 font-mono"
                      data-testid="alert-subscription-sites"
                    >
                      {sub.allSites ? (
                        <Badge variant="secondary" className="font-sans">
                          {m.alert_all_sites()}
                        </Badge>
                      ) : (
                        <>
                          {sub.sites.slice(0, SITE_BADGES).map((site) => (
                            <Badge key={site.id} variant="secondary" className="max-w-48 truncate">
                              {site.name}
                            </Badge>
                          ))}
                          {sub.sites.length > SITE_BADGES ? (
                            <Badge variant="secondary" className="font-sans">
                              {`+${sub.sites.length - SITE_BADGES}`}
                            </Badge>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {sub.kinds.map((kind) => (
                        <Badge key={kind} variant="outline">
                          {label(kind)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end sm:self-start">
                    <Button size="sm" variant="outline" onClick={() => dialog.show(sub)}>
                      {m.common_edit()}
                    </Button>
                    <ConfirmDialog
                      title={m.alert_unsubscribe()}
                      trigger={
                        <Button size="sm" variant="outline">
                          {m.alert_unsubscribe()}
                        </Button>
                      }
                      onConfirm={async () => {
                        await client.alerts.unsubscribe({ id: sub.id });
                        await queries.invalidateQueries();
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </CardContent>
      {dialog.value ? (
        <SubscriptionDialog
          key={dialog.key}
          channels={available}
          initial={dialog.value === "new" ? undefined : dialog.value}
          open={dialog.open}
          onOpenChange={dialog.onOpenChange}
        />
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
    <Card className="animate-enter" style={{ animationDelay: "180ms" }}>
      <CardHeader>
        <CardTitle>{m.alert_recent_events()}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryView query={events} empty={<EmptyState title={m.alert_no_events()} />}>
          {(list) => (
            <ul className="divide-y">
              {list.map((event, index) => {
                const firing = event.status !== "resolved";
                return (
                  <li
                    key={event.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 text-sm animate-enter first:pt-0 last:pb-0 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto_auto]"
                    style={enterDelay(index)}
                  >
                    <span className="order-2 justify-self-end sm:order-none sm:justify-self-start">
                      <StatusDot tone={firing ? "bad" : "good"}>
                        <span className={firing ? "font-medium" : "text-muted-foreground"}>
                          {firing ? m.alert_firing() : m.alert_recovered()}
                        </span>
                      </StatusDot>
                    </span>
                    <span className="order-1 min-w-0 font-medium [overflow-wrap:anywhere] sm:order-none">
                      {event.siteName}
                    </span>
                    <span className="order-3 flex min-w-0 sm:order-none">
                      <Badge variant="outline" className="max-w-full truncate">
                        {label(event.kind)}
                      </Badge>
                    </span>
                    <time
                      dateTime={event.occurredAt}
                      className="order-4 justify-self-end text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:order-none"
                    >
                      {formatDateTime(event.occurredAt)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** The thresholds; the card frames the loading and error states too. */
function PolicyCard() {
  const policy = useQuery(orpc.alerts.policy.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "240ms" }}>
      <CardHeader>
        <CardTitle>{m.alert_policy_title()}</CardTitle>
      </CardHeader>
      <QueryView query={policy} frame={CardContent}>
        {(saved) => <PolicyEditor key={JSON.stringify(saved)} initial={saved} />}
      </QueryView>
    </Card>
  );
}

function PolicyEditor({ initial }: { initial: AlertPolicy }) {
  const [form, setForm] = React.useState(initial),
    [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient(),
    mutation = useMutation(orpc.alerts.setPolicy.mutationOptions());
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
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
  );
}

function ChannelDialog({
  initial,
  open,
  onOpenChange,
}: { initial?: EditableChannel } & DialogProps) {
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
      open={open}
      onOpenChange={onOpenChange}
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
        onOpenChange(false);
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
  initial,
  open,
  onOpenChange,
}: {
  channels: { id: string; name: string }[];
  initial?: Subscription;
} & DialogProps) {
  const [channelId, setChannelId] = React.useState(initial?.channelId ?? channels[0]?.id ?? ""),
    [allSites, setAllSites] = React.useState(initial?.allSites ?? false),
    [sites, setSites] = React.useState<ReadonlyMap<string, string>>(
      () => new Map(initial?.sites.map((site) => [site.id, site.name])),
    ),
    [kinds, setKinds] = React.useState<AlertKind[]>(initial?.kinds ?? [...alertKind.options]),
    [enabled, setEnabled] = React.useState(initial?.enabled ?? true);
  const queries = useQueryClient(),
    subscribe = useMutation(orpc.alerts.subscribe.mutationOptions()),
    update = useMutation(orpc.alerts.updateSubscription.mutationOptions());
  const channelOptions = initial
    ? [{ value: initial.channelId, label: initial.channelName }]
    : channels.map((c) => ({ value: c.id, label: c.name }));
  return (
    <FormDialog
      open={open}
      title={initial ? m.common_edit() : m.alert_subscribe()}
      submitLabel={m.common_save()}
      submitTestId="alert-subscription-submit"
      onOpenChange={onOpenChange}
      onSubmit={async () => {
        if (!channelId || !kinds.length || (!allSites && !sites.size))
          throw new Error(m.alert_check_fields());
        const fields = { kinds, allSites, siteIds: allSites ? [] : [...sites.keys()], enabled };
        if (initial) await update.mutateAsync({ id: initial.id, ...fields });
        else await subscribe.mutateAsync({ channelId, ...fields });
        await queries.invalidateQueries();
        onOpenChange(false);
      }}
    >
      <FormSelect
        id="alert-channel"
        label={m.alert_channel_label()}
        value={channelId}
        options={channelOptions}
        onChange={setChannelId}
        disabled={!!initial}
      />
      <SwitchField
        id="subscribe-all-sites"
        label={m.alert_all_sites()}
        checked={allSites}
        onCheckedChange={setAllSites}
      />
      {allSites ? null : (
        <SiteMultiSelect
          id="alert-sites"
          label={m.nav_sites()}
          searchLabel={m.alert_site_search()}
          selected={sites}
          onChange={setSites}
        />
      )}
      {alertKind.options.map((kind) => (
        <SwitchField
          key={kind}
          id={`subscribe-${kind}`}
          label={label(kind)}
          checked={kinds.includes(kind)}
          onCheckedChange={(checked) =>
            setKinds(checked ? [...kinds, kind] : kinds.filter((k) => k !== kind))
          }
        />
      ))}
      <SwitchField
        id="subscribe-enabled"
        label={m.alert_enable()}
        checked={enabled}
        onCheckedChange={setEnabled}
      />
    </FormDialog>
  );
}
