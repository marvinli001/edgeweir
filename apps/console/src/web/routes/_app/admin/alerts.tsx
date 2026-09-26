import {
  type AlertChannelConfig,
  type AlertPolicy,
  alertChannelConfig,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

type EditableChannel = {
  id: string;
  name: string;
  kind: string;
  availableToTenants: boolean;
  platform: boolean;
  locale: "zh-CN" | "en";
};
export const Route = createFileRoute("/_app/admin/alerts")({ component: AlertAdmin });
const kindLabel = (kind: AlertChannelConfig["kind"]) =>
  ({
    webhook: m.alert_channel_webhook,
    email: m.alert_channel_email,
    dingtalk: m.alert_channel_dingtalk,
    wecom: m.alert_channel_wecom,
    telegram: m.alert_channel_telegram,
  })[kind]();
function AlertAdmin() {
  const channels = useQuery(
      orpc.alerts.channels.queryOptions({ refetchInterval: 15000, meta: { background: true } }),
    ),
    policy = useQuery(orpc.alerts.policy.queryOptions());
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
    <Page
      title={m.alert_admin_title()}
      actions={
        <Button onClick={() => setCreating(true)} data-testid="alert-channel-create">
          {m.alert_channel_add()}
        </Button>
      }
    >
      {channels.isPending ? (
        <LoadingState />
      ) : channels.isError ? (
        <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
      ) : !channels.data.length ? (
        <EmptyState title={m.alert_no_channels()} />
      ) : (
        channels.data.map((channel) => (
          <Card key={channel.id} className="animate-enter">
            <CardContent className="flex flex-wrap items-center gap-3 py-4">
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm font-medium">{channel.name}</p>
                <p className="text-xs text-muted-foreground">
                  {kindLabel(channel.kind as AlertChannelConfig["kind"])}
                </p>
              </div>
              <Badge variant="outline">{channel.enabled ? m.rules_on() : m.rules_off()}</Badge>
              <Button size="sm" variant="outline" onClick={() => setEditing(channel)}>
                {m.common_edit()}
              </Button>
              {channel.lastError ? (
                <Badge variant="destructive">{m.error_alert_send_failed()}</Badge>
              ) : null}
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
            </CardContent>
          </Card>
        ))
      )}
      {policy.isPending ? (
        <LoadingState />
      ) : policy.isError ? (
        <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />
      ) : (
        <PolicyEditor key={JSON.stringify(policy.data)} initial={policy.data} />
      )}
      {creating || editing ? (
        <ChannelDialog
          initial={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      ) : null}
    </Page>
  );
}
function PolicyEditor({ initial }: { initial: AlertPolicy }) {
  const [form, setForm] = React.useState(initial),
    [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient(),
    mutation = useMutation(orpc.alerts.setPolicy.mutationOptions());
  return (
    <Card>
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
        <CardHeader>
          <CardTitle>{m.alert_policy_title()}</CardTitle>
        </CardHeader>
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
    [available, setAvailable] = React.useState(initial?.availableToTenants ?? false),
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
          availableToTenants: available,
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
      <SwitchField
        id="channel-available"
        label={m.alert_tenant_available()}
        checked={available}
        onCheckedChange={setAvailable}
      />
    </FormDialog>
  );
}
