import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, QueryView } from "@/components/states";
import { useTheme } from "@/components/theme-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  formatDateTime,
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
    <Page title={m.settings_title()} width="narrow">
      <Card>
        <CardHeader>
          <CardTitle>{m.settings_preferences()}</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="sm:flex-row">
            <Field>
              <FieldLabel>{m.user_menu_language()}</FieldLabel>
              <OptionSelect
                value={getLocale()}
                options={locales.map((l) => ({ label: localeLabels[l](), value: l }))}
                onChange={setLocale}
                className="w-48"
                testId="settings-language"
              />
            </Field>
            <Field>
              <FieldLabel>{m.user_menu_theme()}</FieldLabel>
              <OptionSelect
                value={theme}
                options={[
                  { label: m.theme_light(), value: "light" },
                  { label: m.theme_dark(), value: "dark" },
                  { label: m.theme_system(), value: "system" },
                ]}
                onChange={setTheme}
                className="w-48"
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <ApiKeysCard />
    </Page>
  );
}

function ApiKeysCard() {
  const queryClient = useQueryClient();
  const [scope, setScope] = React.useState<"read" | "write">("write");
  const keys = useQuery(orpc.accessKeys.list.queryOptions());
  const create = useMutation({
    ...orpc.accessKeys.create.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.accessKeys.key() }),
  });
  const revoke = useMutation({
    ...orpc.accessKeys.revoke.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.accessKeys.key() }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.settings_api_keys()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            create.mutate({ name: String(data.get("keyName") ?? "").trim() || "default", scope });
          }}
        >
          <Field className="w-64">
            <FieldLabel htmlFor="keyName">{m.settings_api_key_name()}</FieldLabel>
            <Input id="keyName" name="keyName" maxLength={64} placeholder="terraform" />
          </Field>
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
          <Button type="submit" disabled={create.isPending} data-testid="access-key-create">
            {create.isPending ? <Spinner /> : null}
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
            <ul className="divide-y rounded-2xl border bg-card text-sm shadow-xs">
              {list.map((k, index) => (
                <li
                  key={k.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5 animate-enter"
                  style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                >
                  <span className="font-medium">{k.name ?? "—"}</span>
                  <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                  <Badge variant="outline">
                    {k.scope === "read" ? m.access_key_read() : m.access_key_write()}
                  </Badge>
                  {!k.enabled ? <Badge variant="secondary">{m.access_key_revoked()}</Badge> : null}
                  <span className="text-xs text-muted-foreground">
                    {m.access_key_last_used({
                      time: k.lastUsedAt ? timeAgo(k.lastUsedAt) : m.common_never(),
                    })}
                  </span>
                  <span
                    className="ml-auto text-xs text-muted-foreground"
                    title={formatDateTime(new Date(k.createdAt).toISOString())}
                  >
                    {timeAgo(new Date(k.createdAt).toISOString())}
                  </span>
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
      </CardContent>
    </Card>
  );
}
