import {
  AUTH_KINDS,
  AUTH_MAX_RULES,
  type AuthKind,
  type AuthRule,
  type AuthRuleInput,
  BASIC_MAX_USERS,
  defaultRealm,
  displaySiteDomain,
  type FeatureAvailability,
  FORWARD_DEFAULT_REQUEST_HEADERS,
  isUrlAuthKind,
  type Site,
  type SiteAuthRules,
  siteAuthRulesInput,
  URL_AUTH_SKEW,
  URL_AUTH_VALIDITY,
} from "@edgeweir/contract";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  Edit02Icon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { CheckboxList } from "@/components/site/ports-card";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { localizeError } from "@/lib/errors";
import { formatDateTime, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { randomUuid } from "@/lib/uuid";

const kindLabel = (kind: AuthKind): string =>
  ({
    basic: m.auth_kind_basic,
    forward: m.auth_kind_forward,
    url_a: m.auth_kind_url_a,
    url_b: m.auth_kind_url_b,
    url_c: m.auth_kind_url_c,
    url_d: m.auth_kind_url_d,
  })[kind]();

/** A rule as the form edits it: numbers and lists as text, write-only secrets empty. */
interface Draft {
  /** The row's key; a saved rule's id. */
  key: string;
  saved: boolean;
  kind: AuthKind;
  enabled: boolean;
  domains: string[];
  pathPrefixes: string;
  extensions: string;
  excludePathPrefixes: string;
  realm: string;
  keepAuthorization: boolean;
  userHeader: boolean;
  /** stored: the user's password is saved (an empty password keeps it). */
  users: { name: string; password: string; stored: boolean }[];
  url: string;
  method: "GET" | "HEAD";
  timeoutSeconds: string;
  requestHeaders: string;
  responseHeaders: string;
  cacheSeconds: string;
  passRedirects: boolean;
  allowUnavailable: boolean;
  validitySeconds: string;
  skewSeconds: string;
  signParam: string;
  timeParam: string;
  primaryKey: string;
  /** The rule's stored kind was a URL kind (its primary key is kept when left empty). */
  primaryStored: boolean;
  backupKey: string;
  backupStored: boolean;
  removeBackup: boolean;
}

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const words = (value: string) => value.split(/[\s,]+/).filter(Boolean);

function newDraft(kind: AuthKind, siteName: string): Draft {
  return {
    key: randomUuid(),
    saved: false,
    kind,
    enabled: true,
    domains: [],
    pathPrefixes: "",
    extensions: "",
    excludePathPrefixes: "",
    realm: defaultRealm(siteName),
    keepAuthorization: false,
    userHeader: false,
    users: [{ name: "", password: "", stored: false }],
    url: "",
    method: "GET",
    timeoutSeconds: "5",
    requestHeaders: FORWARD_DEFAULT_REQUEST_HEADERS.join(", "),
    responseHeaders: "",
    cacheSeconds: "0",
    passRedirects: false,
    allowUnavailable: false,
    validitySeconds: String(URL_AUTH_VALIDITY.default),
    skewSeconds: String(URL_AUTH_SKEW.default),
    signParam: "sign",
    timeParam: "t",
    primaryKey: "",
    primaryStored: false,
    backupKey: "",
    backupStored: false,
    removeBackup: false,
  };
}

function toDraft(rule: AuthRule, siteName: string): Draft {
  const d = newDraft(rule.kind, siteName);
  return {
    ...d,
    key: rule.id,
    saved: true,
    enabled: rule.enabled,
    domains: rule.scope.domains,
    pathPrefixes: rule.scope.pathPrefixes.join("\n"),
    extensions: rule.scope.extensions.join(", "),
    excludePathPrefixes: rule.scope.excludePathPrefixes.join("\n"),
    ...(rule.basic
      ? {
          realm: rule.basic.realm,
          keepAuthorization: rule.basic.keepAuthorization,
          userHeader: rule.basic.userHeader,
          users: rule.basic.users.map((u) => ({ name: u.name, password: "", stored: true })),
        }
      : {}),
    ...(rule.forward
      ? {
          url: rule.forward.url,
          method: rule.forward.method,
          timeoutSeconds: String(rule.forward.timeoutMs / 1000),
          requestHeaders: rule.forward.requestHeaders.join(", "),
          responseHeaders: rule.forward.responseHeaders.join(", "),
          cacheSeconds: String(rule.forward.cacheSeconds),
          passRedirects: rule.forward.passRedirects,
          allowUnavailable: rule.forward.allowUnavailable,
        }
      : {}),
    ...(rule.url
      ? {
          validitySeconds: String(rule.url.validitySeconds),
          skewSeconds: String(rule.url.skewSeconds),
          signParam: rule.url.signParam,
          timeParam: rule.url.timeParam,
          primaryStored: true,
          backupStored: rule.url.backupKey,
        }
      : {}),
  };
}

/** The API's input for a draft (validated by the contract when saved). */
function toInput(d: Draft): AuthRuleInput {
  const base = {
    ...(d.saved ? { id: d.key } : {}),
    kind: d.kind,
    enabled: d.enabled,
    scope: {
      domains: d.domains,
      pathPrefixes: lines(d.pathPrefixes),
      extensions: words(d.extensions),
      excludePathPrefixes: lines(d.excludePathPrefixes),
    },
  };
  if (d.kind === "basic")
    return {
      ...base,
      basic: {
        realm: d.realm,
        keepAuthorization: d.keepAuthorization,
        userHeader: d.userHeader,
        users: d.users.map((u) => ({
          name: u.name.trim(),
          ...(u.password ? { password: u.password } : {}),
        })),
      },
    };
  if (d.kind === "forward")
    return {
      ...base,
      forward: {
        url: d.url.trim(),
        method: d.method,
        timeoutMs: Math.round(Number(d.timeoutSeconds) * 1000),
        requestHeaders: words(d.requestHeaders),
        responseHeaders: words(d.responseHeaders),
        cacheSeconds: Number(d.cacheSeconds),
        passRedirects: d.passRedirects,
        allowUnavailable: d.allowUnavailable,
      },
    };
  return {
    ...base,
    url: {
      validitySeconds: Number(d.validitySeconds),
      skewSeconds: Number(d.skewSeconds),
      signParam: d.signParam.trim(),
      timeParam: d.timeParam.trim(),
      ...(d.primaryKey ? { primaryKey: d.primaryKey } : {}),
      ...(d.removeBackup ? { backupKey: null } : d.backupKey ? { backupKey: d.backupKey } : {}),
    },
  };
}

/** A random signing key: 32 letters and digits. */
function generateKey(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** One line on what a rule covers. */
function scopeSummary(d: Draft): string {
  const parts = [
    ...d.domains.map(displaySiteDomain),
    ...lines(d.pathPrefixes),
    ...words(d.extensions).map((e) => `.${e}`),
  ];
  const excluded = lines(d.excludePathPrefixes);
  const scope = parts.length ? parts.join(" · ") : m.auth_scope_all();
  return excluded.length ? `${scope} − ${excluded.join(" · ")}` : scope;
}

/**
 * The site's access control tab: access authentication rules, checked in order before
 * the rules and the cache (the first enabled rule whose scope matches decides).
 */
export function AccessTab({ site }: { site: Site }) {
  const rules = useQuery(orpc.authRules.get.queryOptions({ input: { id: site.id } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className="animate-enter" data-testid="auth-rules-card">
        <QueryView query={combineQueries(rules, features)} frame={CardContent}>
          {([saved, available]) => (
            <AuthRulesForm
              key={saved.updatedAt ?? "none"}
              site={site}
              initial={saved}
              availability={available.accessAuth}
            />
          )}
        </QueryView>
      </Card>
    </div>
  );
}

function AuthRulesForm({
  site,
  initial,
  availability,
}: {
  site: Site;
  initial: SiteAuthRules;
  availability: FeatureAvailability;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.authRules.update.mutationOptions());
  const saved = React.useMemo(
    () => initial.rules.map((rule) => toDraft(rule, site.name)),
    [initial.rules, site.name],
  );
  const [rows, setRows] = React.useState(saved);
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<{ index: number; draft: Draft } | null>(null);
  const [signing, setSigning] = React.useState<Draft | null>(null);
  // Rules wait until the cluster's nodes check them; saved ones can still be removed.
  const blocked = !availability.available && initial.rules.length === 0;
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const move = (index: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (row) next.splice(index + by, 0, row);
    setRows(next);
  };

  // The dialogs sit outside the form: their own forms' submit events would bubble through the
  // portal into it.
  return (
    <>
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          const parsed = siteAuthRulesInput.safeParse({
            id: site.id,
            rules: rows.map(toInput),
            ...(initial.updatedAt ? { expectedUpdatedAt: initial.updatedAt } : {}),
          });
          if (!parsed.success) {
            setError(localizeError(parsed.error));
            return;
          }
          try {
            const result = await mutation.mutateAsync(parsed.data);
            queryClient.setQueryData(
              orpc.authRules.get.queryKey({ input: { id: site.id } }),
              result,
            );
            toast.success(m.common_saved());
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{m.auth_title()}</CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={blocked || rows.length >= AUTH_MAX_RULES}
            onClick={() => setEditing({ index: rows.length, draft: newDraft("basic", site.name) })}
            data-testid="auth-add"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.auth_add()}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {availability.available ? null : (
            <SafetyNote className="animate-in fade-in" data-testid="auth-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          )}
          {rows.length === 0 ? (
            <EmptyState title={m.auth_empty()}>
              <Button
                type="button"
                disabled={blocked}
                onClick={() => setEditing({ index: 0, draft: newDraft("basic", site.name) })}
                data-testid="auth-add-empty"
              >
                {m.auth_add()}
              </Button>
            </EmptyState>
          ) : (
            <ol className="-mx-(--card-spacing) flex flex-col border-b" data-testid="auth-rules">
              {rows.map((row, index) => (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-(--card-spacing) py-3 animate-enter"
                  style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                  data-testid="auth-rule"
                >
                  <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <Badge variant="outline" data-testid="auth-rule-kind">
                    {kindLabel(row.kind)}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm" title={scopeSummary(row)}>
                    {scopeSummary(row)}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Switch
                      checked={row.enabled}
                      aria-label={m.auth_enabled()}
                      onCheckedChange={(enabled) =>
                        setRows(rows.map((r, i) => (i === index ? { ...r, enabled } : r)))
                      }
                      data-testid="auth-rule-enabled"
                    />
                    {isUrlAuthKind(row.kind) && row.saved ? (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={m.auth_sign()}
                        title={m.auth_sign()}
                        // Signed with what is saved: the form saves first.
                        disabled={dirty}
                        onClick={() => setSigning(row)}
                        data-testid="auth-rule-sign"
                      >
                        <HugeiconsIcon icon={Link01Icon} />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.auth_move_up()}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <HugeiconsIcon icon={ArrowUp01Icon} />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.auth_move_down()}
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <HugeiconsIcon icon={ArrowDown01Icon} />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.auth_edit()}
                      onClick={() => setEditing({ index, draft: row })}
                      data-testid="auth-rule-edit"
                    >
                      <HugeiconsIcon icon={Edit02Icon} />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.common_delete()}
                      onClick={() => setRows(rows.filter((_, i) => i !== index))}
                      data-testid="auth-rule-delete"
                    >
                      <HugeiconsIcon icon={Delete02Icon} />
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
        <SaveBar
          dirty={dirty && !blocked}
          pending={mutation.isPending}
          error={error}
          testId="auth-save"
        />
      </form>
      {editing ? (
        <RuleDialog
          site={site}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onDone={(draft) => {
            const next = [...rows];
            next.splice(editing.index, editing.index < rows.length ? 1 : 0, draft);
            setRows(next);
            setEditing(null);
          }}
        />
      ) : null}
      {signing ? (
        <SignDialog siteId={site.id} rule={signing} onClose={() => setSigning(null)} />
      ) : null}
    </>
  );
}

/** Edits one rule; Done puts it into the list (saved with the list). */
function RuleDialog({
  site,
  initial,
  onClose,
  onDone,
}: {
  site: Site;
  initial: Draft;
  onClose: () => void;
  onDone: (draft: Draft) => void;
}) {
  const [d, setD] = React.useState(initial);
  const [generated, setGenerated] = React.useState<"primary" | "backup" | null>(null);
  const set = (change: Partial<Draft>) => setD({ ...d, ...change });
  const url = isUrlAuthKind(d.kind);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={initial.saved ? m.auth_edit() : m.auth_add()}
      submitLabel={m.auth_done()}
      submitTestId="auth-rule-done"
      className="sm:max-w-2xl"
      onSubmit={async () => {
        // The rule alone, as the list would save it (passwords of new users included).
        const parsed = siteAuthRulesInput.safeParse({ id: site.id, rules: [toInput(d)] });
        if (!parsed.success) throw new Error(localizeError(parsed.error));
        const missing = d.users.find((u) => d.kind === "basic" && !u.stored && !u.password);
        if (missing) throw new Error(m.error_auth_password_required({ user: missing.name || "?" }));
        if (url && !d.primaryStored && !d.primaryKey) throw new Error(m.error_auth_key_required());
        onDone(d);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect
          id="auth-kind"
          label={m.auth_kind()}
          value={d.kind}
          testId="auth-kind"
          options={AUTH_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) }))}
          onChange={(kind) =>
            set({
              kind,
              // A kind's secret does not carry over to another kind's.
              primaryStored: d.primaryStored && isUrlAuthKind(kind),
              backupStored: d.backupStored && isUrlAuthKind(kind),
              users:
                kind === "basic" && d.kind !== "basic"
                  ? [{ name: "", password: "", stored: false }]
                  : d.users,
            })
          }
        />
        <SwitchField
          id="auth-enabled"
          label={m.auth_enabled()}
          checked={d.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
          className="self-end"
          testId="auth-enabled"
        />
      </div>
      {site.domains.length > 1 ? (
        <CheckboxList
          id="auth-domains"
          legend={m.auth_domains()}
          options={site.domains.map((domain) => ({
            value: domain,
            label: displaySiteDomain(domain),
          }))}
          value={d.domains}
          onChange={(domains) => set({ domains })}
          testId="auth-domains"
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="auth-prefixes">{m.auth_path_prefixes()}</FieldLabel>
          <Textarea
            id="auth-prefixes"
            rows={2}
            value={d.pathPrefixes}
            placeholder="/admin/"
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(e) => set({ pathPrefixes: e.target.value })}
            data-testid="auth-prefixes"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="auth-excludes">{m.auth_exclude_prefixes()}</FieldLabel>
          <Textarea
            id="auth-excludes"
            rows={2}
            value={d.excludePathPrefixes}
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(e) => set({ excludePathPrefixes: e.target.value })}
            data-testid="auth-excludes"
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="auth-extensions">{m.auth_extensions()}</FieldLabel>
        <Input
          id="auth-extensions"
          value={d.extensions}
          placeholder="mp4, m3u8"
          spellCheck={false}
          className="font-mono text-sm"
          onChange={(e) => set({ extensions: e.target.value })}
          data-testid="auth-extensions"
        />
      </Field>
      {d.kind === "basic" ? <BasicFields d={d} set={set} /> : null}
      {d.kind === "forward" ? <ForwardFields d={d} set={set} /> : null}
      {url ? (
        <UrlFields
          d={d}
          set={set}
          generated={generated}
          onGenerate={(which) => {
            setGenerated(which);
            set(
              which === "primary"
                ? { primaryKey: generateKey() }
                : { backupKey: generateKey(), removeBackup: false },
            );
          }}
        />
      ) : null}
    </FormDialog>
  );
}

function BasicFields({ d, set }: { d: Draft; set: (change: Partial<Draft>) => void }) {
  const users = d.users;
  const setUser = (index: number, change: Partial<Draft["users"][number]>) =>
    set({ users: users.map((u, i) => (i === index ? { ...u, ...change } : u)) });
  return (
    <>
      <Field>
        <FieldLabel htmlFor="auth-realm">{m.auth_realm()}</FieldLabel>
        <Input
          id="auth-realm"
          value={d.realm}
          maxLength={64}
          onChange={(e) => set({ realm: e.target.value })}
          data-testid="auth-realm"
        />
      </Field>
      <fieldset className="flex flex-col gap-2" data-testid="auth-users">
        <legend className="mb-2 text-sm font-medium">{m.auth_users()}</legend>
        {users.map((user, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: users are edited in place, by position.
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
          >
            <Input
              aria-label={m.auth_user_name()}
              placeholder={m.auth_user_name()}
              value={user.name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              // A renamed user is a new user: it needs a password.
              onChange={(e) => setUser(index, { name: e.target.value, stored: false })}
              data-testid="auth-user-name"
            />
            <Input
              type="password"
              aria-label={m.auth_user_password()}
              placeholder={user.stored ? m.site_secret_saved() : m.auth_user_password()}
              value={user.password}
              autoComplete="new-password"
              onChange={(e) => setUser(index, { password: e.target.value })}
              data-testid="auth-user-password"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={m.common_delete()}
              disabled={users.length === 1}
              onClick={() => set({ users: users.filter((_, i) => i !== index) })}
            >
              <HugeiconsIcon icon={Delete02Icon} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={users.length >= BASIC_MAX_USERS}
          onClick={() => set({ users: [...users, { name: "", password: "", stored: false }] })}
          data-testid="auth-user-add"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.auth_user_add()}
        </Button>
      </fieldset>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <SwitchField
          id="auth-keep-authorization"
          label={m.auth_keep_authorization()}
          checked={d.keepAuthorization}
          onCheckedChange={(keepAuthorization) => set({ keepAuthorization })}
        />
        <SwitchField
          id="auth-user-header"
          label={m.auth_user_header()}
          checked={d.userHeader}
          onCheckedChange={(userHeader) => set({ userHeader })}
          testId="auth-user-header"
        />
      </div>
    </>
  );
}

function ForwardFields({ d, set }: { d: Draft; set: (change: Partial<Draft>) => void }) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="auth-url">{m.auth_forward_url()}</FieldLabel>
        <Input
          id="auth-url"
          value={d.url}
          placeholder="https://auth.example.com/verify"
          spellCheck={false}
          className="font-mono text-sm"
          onChange={(e) => set({ url: e.target.value })}
          data-testid="auth-forward-url"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormSelect
          id="auth-method"
          label={m.auth_forward_method()}
          value={d.method}
          options={[
            { value: "GET", label: "GET" },
            { value: "HEAD", label: "HEAD" },
          ]}
          onChange={(method) => set({ method })}
        />
        <NumberField
          id="auth-timeout"
          label={m.auth_forward_timeout()}
          value={d.timeoutSeconds}
          min={0.1}
          max={10}
          step="any"
          onChange={(timeoutSeconds) => set({ timeoutSeconds })}
        />
        <NumberField
          id="auth-cache"
          label={m.auth_forward_cache()}
          value={d.cacheSeconds}
          min={0}
          max={300}
          onChange={(cacheSeconds) => set({ cacheSeconds })}
          testId="auth-forward-cache"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="auth-request-headers">{m.auth_forward_request_headers()}</FieldLabel>
          <Input
            id="auth-request-headers"
            value={d.requestHeaders}
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(e) => set({ requestHeaders: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="auth-response-headers">
            {m.auth_forward_response_headers()}
          </FieldLabel>
          <Input
            id="auth-response-headers"
            value={d.responseHeaders}
            placeholder="x-auth-user"
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(e) => set({ responseHeaders: e.target.value })}
            data-testid="auth-forward-response-headers"
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <SwitchField
          id="auth-pass-redirects"
          label={m.auth_forward_pass_redirects()}
          checked={d.passRedirects}
          onCheckedChange={(passRedirects) => set({ passRedirects })}
        />
        <SwitchField
          id="auth-allow-unavailable"
          label={m.auth_forward_allow_unavailable()}
          checked={d.allowUnavailable}
          onCheckedChange={(allowUnavailable) => set({ allowUnavailable })}
          testId="auth-forward-allow-unavailable"
        />
      </div>
      {d.allowUnavailable ? (
        <SafetyNote className="animate-in fade-in" data-testid="auth-allow-unavailable-note">
          {m.auth_forward_allow_unavailable_note()}
        </SafetyNote>
      ) : null}
    </>
  );
}

function UrlFields({
  d,
  set,
  generated,
  onGenerate,
}: {
  d: Draft;
  set: (change: Partial<Draft>) => void;
  generated: "primary" | "backup" | null;
  onGenerate: (which: "primary" | "backup") => void;
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="auth-primary-key">{m.auth_primary_key()}</FieldLabel>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input
            id="auth-primary-key"
            value={d.primaryKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={d.primaryStored ? m.site_secret_saved() : undefined}
            onChange={(e) => set({ primaryKey: e.target.value })}
            className="min-w-0 flex-1 font-mono text-sm max-sm:basis-full"
            data-testid="auth-primary-key"
          />
          {generated === "primary" && d.primaryKey ? <CopyButton value={d.primaryKey} /> : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => onGenerate("primary")}
            data-testid="auth-primary-generate"
          >
            {m.auth_generate()}
          </Button>
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor="auth-backup-key">{m.auth_backup_key()}</FieldLabel>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input
            id="auth-backup-key"
            value={d.backupKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={d.backupStored && !d.removeBackup ? m.site_secret_saved() : undefined}
            onChange={(e) => set({ backupKey: e.target.value, removeBackup: false })}
            className="min-w-0 flex-1 font-mono text-sm max-sm:basis-full"
            data-testid="auth-backup-key"
          />
          {generated === "backup" && d.backupKey ? <CopyButton value={d.backupKey} /> : null}
          <Button type="button" variant="outline" onClick={() => onGenerate("backup")}>
            {m.auth_generate()}
          </Button>
          {d.backupStored && !d.removeBackup ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => set({ backupKey: "", removeBackup: true })}
              data-testid="auth-backup-remove"
            >
              {m.auth_backup_remove()}
            </Button>
          ) : null}
        </div>
      </Field>
      {generated ? (
        <SafetyNote className="animate-in fade-in" data-testid="auth-key-generated">
          {m.site_purge_method_generated()}
        </SafetyNote>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id="auth-validity"
          label={m.auth_validity()}
          value={d.validitySeconds}
          min={URL_AUTH_VALIDITY.min}
          max={URL_AUTH_VALIDITY.max}
          onChange={(validitySeconds) => set({ validitySeconds })}
          testId="auth-validity"
        />
        <NumberField
          id="auth-skew"
          label={m.auth_skew()}
          value={d.skewSeconds}
          min={URL_AUTH_SKEW.min}
          max={URL_AUTH_SKEW.max}
          onChange={(skewSeconds) => set({ skewSeconds })}
        />
      </div>
      {d.kind === "url_a" || d.kind === "url_d" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="auth-sign-param">{m.auth_sign_param()}</FieldLabel>
            <Input
              id="auth-sign-param"
              value={d.signParam}
              maxLength={32}
              spellCheck={false}
              className="font-mono text-sm"
              onChange={(e) => set({ signParam: e.target.value })}
            />
          </Field>
          {d.kind === "url_d" ? (
            <Field>
              <FieldLabel htmlFor="auth-time-param">{m.auth_time_param()}</FieldLabel>
              <Input
                id="auth-time-param"
                value={d.timeParam}
                maxLength={32}
                spellCheck={false}
                className="font-mono text-sm"
                onChange={(e) => set({ timeParam: e.target.value })}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Signs a URL with a saved URL rule's primary key, in the console. */
function SignDialog({
  siteId,
  rule,
  onClose,
}: {
  siteId: string;
  rule: Draft;
  onClose: () => void;
}) {
  const sign = useMutation(orpc.authRules.signUrl.mutationOptions());
  const [target, setTarget] = React.useState("");
  const [validity, setValidity] = React.useState(rule.validitySeconds);
  const [result, setResult] = React.useState<{ url: string; expiresAt: string } | null>(null);
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={m.auth_sign()}
      submitLabel={m.auth_sign_submit()}
      submitTestId="auth-sign-submit"
      onSubmit={async () => {
        setResult(
          await sign.mutateAsync({
            id: siteId,
            ruleId: rule.key,
            url: target.trim(),
            validitySeconds: Number(validity),
          }),
        );
      }}
    >
      <Field>
        <FieldLabel htmlFor="auth-sign-url">{m.auth_sign_url()}</FieldLabel>
        <Input
          id="auth-sign-url"
          value={target}
          required
          placeholder="/videos/intro.mp4"
          spellCheck={false}
          className="font-mono text-sm"
          onChange={(e) => {
            setTarget(e.target.value);
            setResult(null);
          }}
          data-testid="auth-sign-url"
        />
      </Field>
      <NumberField
        id="auth-sign-validity"
        label={m.auth_sign_validity()}
        value={validity}
        min={1}
        max={Number(rule.validitySeconds)}
        onChange={(value) => {
          setValidity(value);
          setResult(null);
        }}
        testId="auth-sign-validity"
      />
      {result ? (
        <div className="flex min-w-0 flex-col gap-2 animate-in fade-in" data-testid="auth-signed">
          <div className="flex min-w-0 items-center gap-2">
            <code
              className="min-w-0 flex-1 break-all rounded-md bg-well px-2 py-1.5 font-mono text-xs"
              data-testid="auth-signed-url"
            >
              {result.url}
            </code>
            <CopyButton value={result.url} iconOnly />
          </div>
          <p className="text-xs text-muted-foreground">
            {m.auth_sign_expires({ time: formatDateTime(result.expiresAt) })}
          </p>
        </div>
      ) : null}
    </FormDialog>
  );
}
