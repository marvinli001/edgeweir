import {
  type AlertChannelConfig,
  type AlertEventKind,
  type AlertKind,
  type AlertPolicy,
  alertChannelConfig,
  alertKind,
  alertPolicy,
} from "@edgeweir/contract";
import {
  Add01Icon,
  Mail01Icon,
  Message01Icon,
  SmartPhone01Icon,
  TelegramIcon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { enterDelay, Page } from "@/components/page";
import { SettingsCard } from "@/components/settings-card";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SiteMultiSelect } from "@/components/site-multi-select";
import { SmtpSettings } from "@/components/smtp-settings";
import { EmptyState, type QueryResult, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { formatDateTime, m } from "@/lib/i18n";
import { splitList } from "@/lib/lists";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { toast } from "@/lib/toast";

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
    usage_warning: m.alert_kind_usage_warning,
    usage_limit: m.alert_kind_usage_limit,
    node_clock_skew: m.alert_kind_node_clock_skew,
    config_rollout_failed: m.alert_kind_config_rollout_failed,
    config_rollout_no_canary: m.alert_kind_config_rollout_no_canary,
    config_rule_invalid: m.alert_kind_config_rule_invalid,
    dns_mass_removal_blocked: m.alert_kind_dns_mass_removal_blocked,
    scheduling_action: m.alert_kind_scheduling_action,
    certificate_unloadable: m.alert_kind_certificate_unloadable,
    dns_reconcile_failed: m.alert_kind_dns_reconcile_failed,
  })[kind]();
const kindLabel = (kind: AlertChannelConfig["kind"]) =>
  ({
    webhook: m.alert_channel_webhook,
    email: m.alert_channel_email,
    dingtalk: m.alert_channel_dingtalk,
    wecom: m.alert_channel_wecom,
    telegram: m.alert_channel_telegram,
    aliyun_sms: m.alert_channel_aliyun_sms,
    tencent_sms: m.alert_channel_tencent_sms,
  })[kind]();
const KIND_ICON: Record<AlertChannelConfig["kind"], typeof WebhookIcon> = {
  webhook: WebhookIcon,
  email: Mail01Icon,
  dingtalk: Message01Icon,
  wecom: Message01Icon,
  telegram: TelegramIcon,
  aliyun_sms: SmartPhone01Icon,
  tencent_sms: SmartPhone01Icon,
};
type ConfigField = {
  name: string;
  label: () => string;
  /** secret: a password input; list: split on spaces and commas; number: the default shown. */
  type?: "secret" | "list" | "number";
  optional?: boolean;
  initial?: number;
};
const smsFields = (maxParamLength: number): ConfigField[] => [
  { name: "phoneNumbers", label: m.alert_phone_numbers, type: "list" },
  {
    name: "maxParamLength",
    label: m.alert_sms_param_length,
    type: "number",
    initial: maxParamLength,
  },
  { name: "hourlyLimit", label: m.alert_sms_hourly_limit, type: "number", initial: 10 },
  { name: "dailyLimit", label: m.alert_sms_daily_limit, type: "number", initial: 50 },
];
const endpointField: ConfigField = { name: "url", label: m.alert_endpoint };
const CONFIG_FIELDS: Record<AlertChannelConfig["kind"], ConfigField[]> = {
  webhook: [
    endpointField,
    { name: "bearer", label: m.alert_bearer, type: "secret", optional: true },
  ],
  email: [{ name: "to", label: m.alert_recipients, type: "list" }],
  dingtalk: [
    endpointField,
    { name: "secret", label: m.alert_signing_secret, type: "secret", optional: true },
  ],
  wecom: [endpointField],
  telegram: [
    { name: "token", label: m.alert_bot_token, type: "secret" },
    { name: "chatId", label: m.alert_chat_id },
  ],
  aliyun_sms: [
    { name: "accessKeyId", label: m.alert_access_key_id },
    { name: "accessKeySecret", label: m.alert_access_key_secret, type: "secret" },
    { name: "signName", label: m.alert_sms_sign_name },
    { name: "templateCode", label: m.alert_sms_template_code },
    ...smsFields(35),
  ],
  tencent_sms: [
    { name: "secretId", label: m.alert_secret_id },
    { name: "secretKey", label: m.alert_secret_key, type: "secret" },
    { name: "sdkAppId", label: m.alert_sdk_app_id },
    { name: "signName", label: m.alert_sms_sign_name },
    { name: "templateId", label: m.alert_sms_template_id },
    ...smsFields(6),
  ],
};
const CHANNEL_KINDS = Object.keys(CONFIG_FIELDS) as AlertChannelConfig["kind"][];
/** The channel's last delivery error: a lower-case code, an SMS refusal with the provider's code. */
function channelError(code: string) {
  if (code === "alert_smtp_not_configured") return m.error_alert_smtp_not_configured();
  if (code === "alert_rate_limited") return m.error_alert_rate_limited();
  if (code.startsWith("alert_sms_rejected:"))
    return m.error_alert_sms_rejected({ code: code.slice("alert_sms_rejected:".length) });
  return m.error_alert_send_failed();
}

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
    },
    meta: { invalidates: [orpc.alerts.key()], success: m.common_saved },
  });
  const run = (action: "toggle" | "test" | "delete", id: string, enabled?: boolean) =>
    mutation.mutateAsync({ action, id, enabled });
  const act = (action: "toggle" | "test", id: string, enabled?: boolean) =>
    run(action, id, enabled).catch((e: unknown) => toast.error(errorMessage(e)));
  return (
    <Card className="animate-enter">
      <CardHeader>
        <CardTitle>{m.alert_channels_title()}</CardTitle>
        <CardAction>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => dialog.show("new")}
            data-testid="alert-channel-create"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
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
                        <Badge size="sm" tone="neutral">
                          {m.alert_platform_scope()}
                        </Badge>
                      ) : null}
                      {channel.lastError ? (
                        <Badge
                          size="sm"
                          tone="danger"
                          className="h-auto min-h-5 shrink whitespace-normal [overflow-wrap:anywhere]"
                        >
                          {channelError(channel.lastError)}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-1 sm:justify-end">
                    <Button size="sm" variant="secondary" onClick={() => dialog.show(channel)}>
                      {m.common_edit()}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={mutation.isPending}
                      onClick={() => void act("test", channel.id)}
                    >
                      {m.alert_test_send()}
                    </Button>
                    <Button
                      variant="secondary"
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
                        <Button variant="danger" size="sm" disabled={mutation.isPending}>
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
            variant="secondary"
            onClick={() => dialog.show("new")}
            disabled={!subscriptions.data || !available.length}
            data-testid="alert-subscribe"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
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
                    <div className="flex flex-wrap gap-1" data-testid="alert-subscription-sites">
                      {sub.allSites ? (
                        <Badge size="sm" tone="neutral">
                          {m.alert_all_sites()}
                        </Badge>
                      ) : (
                        <>
                          {sub.sites.slice(0, SITE_BADGES).map((site) => (
                            <Badge
                              size="sm"
                              key={site.id}
                              tone="neutral"
                              className="max-w-48 truncate"
                            >
                              {site.name}
                            </Badge>
                          ))}
                          {sub.sites.length > SITE_BADGES ? (
                            <Badge
                              size="sm"
                              tone="neutral"
                            >{`+${sub.sites.length - SITE_BADGES}`}</Badge>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {sub.kinds.map((kind) => (
                        <Badge size="sm" key={kind} tone="neutral">
                          {label(kind)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end sm:self-start">
                    <Button size="sm" variant="secondary" onClick={() => dialog.show(sub)}>
                      {m.common_edit()}
                    </Button>
                    <ConfirmDialog
                      title={m.alert_unsubscribe()}
                      trigger={
                        <Button size="sm" variant="secondary">
                          {m.alert_unsubscribe()}
                        </Button>
                      }
                      onConfirm={async () => {
                        await client.alerts.unsubscribe({ id: sub.id });
                        await queries.invalidateQueries({ queryKey: orpc.alerts.key() });
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
                    {/*
                      Phones: the kind and the time share the second line while they fit; a longer
                      kind keeps its full text and the time drops to a line of its own.
                    */}
                    <span className="order-3 col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:order-none sm:contents">
                      <Badge
                        size="sm"
                        tone="neutral"
                        className="h-auto min-h-5 max-w-full justify-start text-left whitespace-normal"
                      >
                        {label(event.kind)}
                      </Badge>
                      <time
                        dateTime={event.occurredAt}
                        className="ml-auto shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:justify-self-end"
                      >
                        {formatDateTime(event.occurredAt)}
                      </time>
                    </span>
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
  return (
    <SettingsCard
      title={m.alert_policy_title()}
      query={orpc.alerts.policy.queryOptions()}
      className="animate-enter"
      style={{ animationDelay: "240ms" }}
      mutation={orpc.alerts.setPolicy.mutationOptions()}
      toDraft={(saved: AlertPolicy) => saved}
      toInput={(draft) => draft}
      check={(input) => (alertPolicy.safeParse(input).success ? null : m.alert_check_fields())}
      contentClassName="grid gap-4 sm:grid-cols-2"
      saveTestId="alert-policy-save"
    >
      {({ draft, set }) => (
        <>
          {(
            [
              ["nodeOfflineSeconds", m.alert_offline_seconds(), 45, 3600],
              ["certificateHours", m.alert_certificate_hours(), 1, 720],
              ["minimumRequests", m.alert_minimum_requests(), 1, 1000000],
              ["windowMinutes", m.alert_window_minutes(), 1, 60],
              ["clockSkewSeconds", m.alert_clock_skew_seconds(), 5, 3600],
            ] as const
          ).map(([key, label, min, max]) => (
            <NumberField
              key={key}
              id={`alert-${key}`}
              label={label}
              value={String(draft[key])}
              min={min}
              max={max}
              onChange={(value) => set({ [key]: Number(value) })}
            />
          ))}
          <NumberField
            id="alert-ratio"
            label={m.alert_error_ratio()}
            value={String(Math.round(draft.errorRatio * 100))}
            min={1}
            max={100}
            onChange={(value) => set({ errorRatio: Number(value) / 100 })}
          />
        </>
      )}
    </SettingsCard>
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
  const meta = { invalidates: [orpc.alerts.key()] };
  const update = useMutation({ ...orpc.alerts.updateChannel.mutationOptions(), meta });
  const mutation = useMutation({ ...orpc.alerts.createChannel.mutationOptions(), meta });
  const [region, setRegion] = React.useState("ap-guangzhou");
  const fields = CONFIG_FIELDS[kind];
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
          if (kind === "tencent_sms") values.region = region;
          for (const field of fields) {
            const value = String(data.get(field.name) ?? "").trim();
            if (field.type === "list") values[field.name] = splitList(value);
            else if (field.type === "number")
              values[field.name] = value ? Number(value) : undefined;
            else if (value) values[field.name] = value;
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
        options={CHANNEL_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) }))}
      />
      {replaceConfig && kind === "tencent_sms" ? (
        <FormSelect
          id="channel-region"
          label={m.alert_sms_region()}
          value={region}
          onChange={setRegion}
          options={[
            { value: "ap-guangzhou", label: m.alert_sms_region_guangzhou() },
            { value: "ap-beijing", label: m.alert_sms_region_beijing() },
            { value: "ap-nanjing", label: m.alert_sms_region_nanjing() },
          ]}
        />
      ) : null}
      {replaceConfig &&
        fields.map((field) => (
          <Field key={`${kind}-${field.name}`}>
            <FieldLabel htmlFor={`channel-${field.name}`}>{field.label()}</FieldLabel>
            <Input
              id={`channel-${field.name}`}
              name={field.name}
              required={!field.optional}
              type={
                field.type === "secret" ? "password" : field.type === "number" ? "number" : "text"
              }
              defaultValue={field.initial}
              min={field.type === "number" ? 1 : undefined}
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
  const meta = { invalidates: [orpc.alerts.key()] };
  const subscribe = useMutation({ ...orpc.alerts.subscribe.mutationOptions(), meta }),
    update = useMutation({ ...orpc.alerts.updateSubscription.mutationOptions(), meta });
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
