import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CodeBlock } from "@/components/copy-button";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import {
  formatDateTime,
  getLocale,
  type Locale,
  localeLabels,
  locales,
  m,
  setLocale,
  timeAgo,
} from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { theme, setTheme } = useTheme();
  return (
    <Page title={m.settings_title()}>
      <Card>
        <CardHeader>
          <CardTitle>{m.settings_preferences()}</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="sm:flex-row">
            <Field>
              <FieldLabel>{m.user_menu_language()}</FieldLabel>
              <Select
                value={getLocale()}
                onValueChange={(value) => value && setLocale(value as Locale)}
                items={locales.map((l) => ({ label: localeLabels[l](), value: l }))}
              >
                <SelectTrigger className="w-48" data-testid="settings-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((l) => (
                    <SelectItem key={l} value={l}>
                      {localeLabels[l]()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{m.user_menu_theme()}</FieldLabel>
              <Select
                value={theme}
                onValueChange={(value) => value && setTheme(value as "light" | "dark" | "system")}
                items={[
                  { label: m.theme_light(), value: "light" },
                  { label: m.theme_dark(), value: "dark" },
                  { label: m.theme_system(), value: "system" },
                ]}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">{m.theme_light()}</SelectItem>
                  <SelectItem value="dark">{m.theme_dark()}</SelectItem>
                  <SelectItem value="system">{m.theme_system()}</SelectItem>
                </SelectContent>
              </Select>
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
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const { data, error } = await authClient.apiKey.list();
      if (error) throw new Error(error.message ?? error.statusText);
      return Array.isArray(data) ? data : (data?.apiKeys ?? []);
    },
  });
  const create = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await authClient.apiKey.create({ name });
      if (error) throw new Error(error.message ?? error.statusText);
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
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
            create.mutate(String(data.get("keyName") ?? "").trim() || "default");
          }}
        >
          <Field className="w-64">
            <FieldLabel htmlFor="keyName">{m.settings_api_key_name()}</FieldLabel>
            <Input id="keyName" name="keyName" maxLength={64} placeholder="terraform" />
          </Field>
          <Button type="submit" disabled={create.isPending}>
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
            <FieldDescription>{m.settings_api_key_created()}</FieldDescription>
          </Field>
        ) : null}
        {keys.isPending ? (
          <LoadingState className="min-h-24" />
        ) : keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
        ) : keys.data.length === 0 ? (
          <EmptyState title={m.settings_api_keys_empty()} />
        ) : (
          <ul className="divide-y rounded-2xl border bg-card text-sm shadow-xs">
            {keys.data.map((k, index) => (
              <li
                key={k.id}
                className="flex flex-wrap items-center gap-3 px-3 py-2.5 animate-enter"
                style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
              >
                <span className="font-medium">{k.name ?? "—"}</span>
                <code className="text-xs text-muted-foreground">{k.start ?? k.prefix ?? "—"}…</code>
                <span
                  className="ml-auto text-xs text-muted-foreground"
                  title={formatDateTime(new Date(k.createdAt).toISOString())}
                >
                  {timeAgo(new Date(k.createdAt).toISOString())}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
