import {
  ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE,
  ACCESS_KEY_MAX_REQUESTS_PER_MINUTE,
  type AccessKey,
} from "@edgeweir/contract";
import { Add01Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { enterDelay, Page } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { useTheme } from "@/components/theme-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDialogState } from "@/hooks/use-dialog-state";
import {
  formatDateTime,
  formatNumber,
  getLocale,
  localeLabels,
  locales,
  m,
  setLocale,
  timeAgo,
} from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { theme, setTheme } = useTheme();
  return (
    <Page title={m.settings_title()}>
      {/* Short forms keep a narrow column, at the start of the page column like the title. */}
      <div className="flex w-full max-w-[56rem] flex-col gap-6">
        <Card className="animate-enter">
          <CardHeader>
            <CardTitle>{m.settings_preferences()}</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup className="sm:flex-row sm:gap-4">
              <Field className="sm:w-48">
                <FieldLabel>{m.user_menu_language()}</FieldLabel>
                <OptionSelect
                  value={getLocale()}
                  options={locales.map((l) => ({ label: localeLabels[l](), value: l }))}
                  onChange={setLocale}
                  className="w-full sm:w-48"
                  testId="settings-language"
                />
              </Field>
              <Field className="sm:w-48">
                <FieldLabel>{m.user_menu_theme()}</FieldLabel>
                <OptionSelect
                  value={theme}
                  options={[
                    { label: m.theme_light(), value: "light" },
                    { label: m.theme_dark(), value: "dark" },
                    { label: m.theme_system(), value: "system" },
                  ]}
                  onChange={setTheme}
                  className="w-full sm:w-48"
                />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <ApiKeysCard />
      </div>
    </Page>
  );
}

/** The limit field's value: empty is no limit (null); undefined when it is not a valid limit. */
function requestsPerMinuteOf(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= ACCESS_KEY_MAX_REQUESTS_PER_MINUTE
    ? value
    : undefined;
}

function RequestsPerMinuteField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <NumberField
      id={id}
      label={m.access_key_requests_per_minute()}
      value={value}
      onChange={onChange}
      min={1}
      max={ACCESS_KEY_MAX_REQUESTS_PER_MINUTE}
      step={1}
      placeholder={m.access_key_no_limit()}
      invalid={requestsPerMinuteOf(value) === undefined}
      testId={id}
    />
  );
}

function rateLabel(requestsPerMinute: number | null) {
  return requestsPerMinute === null
    ? m.access_key_unlimited_rate()
    : m.access_key_rate({ count: formatNumber(requestsPerMinute) });
}

function EditKeyDialog({
  accessKey,
  open,
  onOpenChange,
}: {
  accessKey: AccessKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useMutation({
    ...orpc.accessKeys.update.mutationOptions(),
    meta: { invalidates: [orpc.accessKeys.key()], success: m.access_key_saved },
  });
  const [limit, setLimit] = React.useState(
    accessKey.requestsPerMinute === null ? "" : String(accessKey.requestsPerMinute),
  );
  const requestsPerMinute = requestsPerMinuteOf(limit);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.access_key_edit()}
      submitLabel={m.common_save()}
      submitTestId="access-key-save"
      submitDisabled={requestsPerMinute === undefined}
      onSubmit={async (data) => {
        if (requestsPerMinute === undefined) return;
        const name = String(data.get("editKeyName") ?? "").trim();
        await update.mutateAsync({ id: accessKey.id, name, requestsPerMinute });
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="editKeyName">{m.settings_api_key_name()}</FieldLabel>
        <Input
          id="editKeyName"
          name="editKeyName"
          required
          maxLength={64}
          defaultValue={accessKey.name}
        />
      </Field>
      <RequestsPerMinuteField id="access-key-edit-limit" value={limit} onChange={setLimit} />
    </FormDialog>
  );
}

function ApiKeysCard() {
  const [scope, setScope] = React.useState<"read" | "write">("write");
  const [limit, setLimit] = React.useState(String(ACCESS_KEY_DEFAULT_REQUESTS_PER_MINUTE));
  const requestsPerMinute = requestsPerMinuteOf(limit);
  const edit = useDialogState<AccessKey>();
  const keys = useQuery(orpc.accessKeys.list.queryOptions());
  const create = useMutation({
    ...orpc.accessKeys.create.mutationOptions(),
    meta: { invalidates: [orpc.accessKeys.key()] },
  });
  const revoke = useMutation({
    ...orpc.accessKeys.revoke.mutationOptions(),
    meta: { invalidates: [orpc.accessKeys.key()] },
  });

  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <CardHeader>
        <CardTitle>{m.settings_api_keys()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (requestsPerMinute === undefined) return;
            const data = new FormData(event.currentTarget);
            create.mutate({
              name: String(data.get("keyName") ?? "").trim() || "default",
              scope,
              requestsPerMinute,
            });
          }}
        >
          <Field className="w-full sm:w-64">
            <FieldLabel htmlFor="keyName">{m.settings_api_key_name()}</FieldLabel>
            <Input id="keyName" name="keyName" maxLength={64} placeholder="terraform" />
          </Field>
          <div className="w-full sm:w-40">
            <FormSelect
              id="keyScope"
              label={m.access_key_scope()}
              value={scope}
              onChange={(value) => setScope(value as typeof scope)}
              options={[
                { value: "read", label: m.access_key_read() },
                { value: "write", label: m.access_key_write() },
              ]}
            />
          </div>
          <div className="w-full sm:w-40">
            <RequestsPerMinuteField id="access-key-limit" value={limit} onChange={setLimit} />
          </div>
          <Button
            type="submit"
            disabled={create.isPending || requestsPerMinute === undefined}
            data-testid="access-key-create"
          >
            {create.isPending ? <Spinner /> : <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />}
            {m.settings_api_key_create()}
          </Button>
        </form>
        {create.isError ? (
          <FieldError>{errorMessage(create.error, m.common_unknown_error())}</FieldError>
        ) : null}
        {create.data?.key ? (
          <Field className="animate-enter">
            <CodeBlock value={create.data.key} testId="new-api-key" />
            <SafetyNote>{m.settings_api_key_created()}</SafetyNote>
          </Field>
        ) : null}
        <QueryView
          query={keys}
          loadingClassName="min-h-24"
          empty={<EmptyState title={m.settings_api_keys_empty()} />}
        >
          {(list) => (
            <ul
              className="divide-y divide-edge rounded-2xl text-sm sunk-well"
              data-testid="access-keys"
            >
              {list.map((k, index) => (
                <li
                  key={k.id}
                  className="flex min-h-12 items-center gap-3 px-3 py-2 animate-enter"
                  style={enterDelay(index)}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-medium">{k.name ?? "—"}</span>
                      <code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code>
                      <Badge variant="outline">
                        {k.scope === "read" ? m.access_key_read() : m.access_key_write()}
                      </Badge>
                      {!k.enabled ? (
                        <Badge variant="secondary">{m.access_key_revoked()}</Badge>
                      ) : null}
                    </span>
                    <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                      <span data-testid="access-key-rate">{rateLabel(k.requestsPerMinute)}</span>
                      <span>
                        {m.access_key_last_used({
                          time: k.lastUsedAt ? timeAgo(k.lastUsedAt) : m.common_never(),
                        })}
                      </span>
                      <span title={formatDateTime(new Date(k.createdAt).toISOString())}>
                        {timeAgo(new Date(k.createdAt).toISOString())}
                      </span>
                    </span>
                  </div>
                  {k.enabled ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.access_key_edit()}
                      onClick={() => edit.show(k)}
                      data-testid="access-key-edit"
                    >
                      <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                    </Button>
                  ) : null}
                  {k.enabled ? (
                    <ConfirmDialog
                      title={m.access_key_revoke()}
                      trigger={
                        <Button size="sm" variant="outline" disabled={revoke.isPending}>
                          {m.access_key_revoke()}
                        </Button>
                      }
                      onConfirm={() => revoke.mutateAsync({ id: k.id })}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </QueryView>
        {edit.value ? (
          <EditKeyDialog
            key={`edit-${edit.key}`}
            accessKey={edit.value}
            open={edit.open}
            onOpenChange={edit.onOpenChange}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
