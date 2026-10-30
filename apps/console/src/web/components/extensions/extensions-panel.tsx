import type {
  ExtensionDetail,
  ExtensionKeyView,
  ExtensionSummary,
  NodeExtensionState,
  VerifiedExtensionPackage,
} from "@edgeweir/contract";
import { Add01Icon, PuzzleIcon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { DropdownMenuItem } from "@/components/arc/dropdown-menu/dropdown-menu";
import { Input } from "@/components/arc/input/input";
import { Switch } from "@/components/arc/switch/switch";
import { Textarea } from "@/components/arc/textarea/textarea";
import { ConfirmDialog, ControlledConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import {
  type ConfigDraft,
  configDraft,
  configFromDraft,
  hasConfigFields,
  localizedText,
  SchemaForm,
} from "@/components/extensions/schema-form";
import { FormDialog } from "@/components/form-dialog";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/layout/form";
import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import { enterDelay } from "@/components/page";
import { ItemMenu } from "@/components/row-menu";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot, type StatusTone } from "@/components/status-dot";
import { TimeAgo } from "@/components/time-ago";
import { useDialogState } from "@/hooks/use-dialog-state";
import { useOpenKey } from "@/hooks/use-open-key";
import { formatBytes, formatDateTime, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { rowLink, rowLinkButton } from "@/lib/row-link";
import { cn } from "@/lib/utils";

const invalidates = () => [orpc.extensions.key(), orpc.extensionKeys.key()];

/** The bytes of a file, base64 (the API takes packages as JSON). */
async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function Facts({ children }: { children: React.ReactNode }) {
  return <dl className="divide-y divide-edge">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-10 gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm break-all">{children}</dd>
    </div>
  );
}

function Names({ list }: { list: readonly string[] }) {
  if (list.length === 0) return <span className="text-muted-foreground">—</span>;
  return list.map((name) => (
    <Badge key={name} size="sm" tone="neutral" className="font-mono">
      {name}
    </Badge>
  ));
}

const NODE_STATE: Record<string, { tone: StatusTone; label: () => string }> = {
  loaded: { tone: "good", label: m.extensions_node_loaded },
  pending: { tone: "idle", label: m.extensions_node_pending },
  disabled: { tone: "idle", label: m.extensions_node_disabled },
  unsupported: { tone: "warn", label: m.extensions_node_unsupported },
  incompatible: { tone: "bad", label: m.extensions_node_incompatible },
  failed: { tone: "bad", label: m.extensions_node_failed },
};

function NodeState({ state }: { state: string }) {
  const known = NODE_STATE[state];
  return <StatusDot tone={known?.tone ?? "idle"}>{known ? known.label() : state}</StatusDot>;
}

/** An extension's state in the list: off, every node loaded it, or some fail. */
function ExtensionStatus({ extension }: { extension: ExtensionSummary }) {
  if (!extension.enabled) return <StatusDot tone="idle">{m.extensions_disabled()}</StatusDot>;
  if (extension.nodesFailing > 0)
    return (
      <StatusDot tone="bad">
        {m.extensions_nodes_failing({ count: extension.nodesFailing })}
      </StatusDot>
    );
  return <StatusDot tone="good">{m.extensions_enabled()}</StatusDot>;
}

/** The enabled switch of a row (a component of its own: column templates hold no hooks). */
function EnabledSwitch({ extension }: { extension: ExtensionSummary }) {
  const update = useMutation({
    ...orpc.extensions.update.mutationOptions(),
    meta: { invalidates: invalidates(), toastError: true },
  });
  return (
    <Switch
      checked={extension.enabled}
      disabled={update.isPending}
      aria-label={m.extensions_enabled()}
      onCheckedChange={(enabled) => update.mutate({ id: extension.id, enabled })}
      data-testid="extension-enabled"
    />
  );
}

/** The kill switch: nodes run no extension while it is off. */
function KillSwitch() {
  const settings = useQuery(orpc.extensions.settings.queryOptions());
  const update = useMutation({
    ...orpc.extensions.updateSettings.mutationOptions(),
    meta: { invalidates: invalidates(), toastError: true },
  });
  const [confirming, setConfirming] = React.useState(false);
  return (
    <Panel className="animate-enter" data-testid="extensions-kill-switch">
      <PanelHeader>
        <PanelTitle>{m.extensions_run_title()}</PanelTitle>
      </PanelHeader>
      <PanelContent className="flex flex-col gap-3">
        <QueryView query={settings}>
          {({ disabled }) => (
            <>
              <SwitchField
                id="extensions-run"
                label={m.extensions_run_label()}
                checked={!disabled}
                disabled={update.isPending}
                onCheckedChange={(on) =>
                  on ? update.mutate({ disabled: false }) : setConfirming(true)
                }
                className="self-start"
                testId="extensions-run"
              />
              {disabled ? <SafetyNote>{m.extensions_run_off_note()}</SafetyNote> : null}
            </>
          )}
        </QueryView>
      </PanelContent>
      <ControlledConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        destructive
        title={m.extensions_run_off_confirm()}
        confirmLabel={m.extensions_run_off()}
        onConfirm={() => update.mutateAsync({ disabled: true })}
      />
    </Panel>
  );
}

/** Upload a package and its signature, check them, then install (or upgrade). */
function InstallDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (id: string) => void;
}) {
  const verify = useMutation(orpc.extensions.verify.mutationOptions());
  const install = useMutation({
    ...orpc.extensions.install.mutationOptions(),
    meta: { invalidates: invalidates(), success: m.extensions_installed },
  });
  const [pkg, setPkg] = React.useState<File | null>(null);
  const [signature, setSignature] = React.useState("");
  const [verified, setVerified] = React.useState<VerifiedExtensionPackage | null>(null);
  const input = async () => ({ package: await fileBase64(pkg as File), signature });
  const manifest = verified?.manifest;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.extensions_install()}
      submitLabel={verified ? m.extensions_install_submit() : m.extensions_verify()}
      submitDisabled={!pkg || signature.trim() === ""}
      submitTestId="extension-install-submit"
      className="sm:max-w-xl"
      onSubmit={async () => {
        if (!verified) {
          setVerified(await verify.mutateAsync(await input()));
          return;
        }
        const detail = await install.mutateAsync(await input());
        onOpenChange(false);
        onInstalled(detail.id);
      }}
    >
      <Field>
        <FieldLabel htmlFor="extension-package">{m.extensions_package()}</FieldLabel>
        <Input
          id="extension-package"
          type="file"
          accept=".ewx"
          required
          onChange={(event) => {
            setPkg(event.target.files?.[0] ?? null);
            setVerified(null);
          }}
          data-testid="extension-package"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="extension-signature">{m.extensions_signature()}</FieldLabel>
        <Input
          type="file"
          accept=".sig"
          aria-label={m.extensions_signature()}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) setSignature((await file.text()).trim());
            setVerified(null);
          }}
          data-testid="extension-signature-file"
        />
        <Textarea
          id="extension-signature"
          value={signature}
          rows={3}
          spellCheck={false}
          onChange={(event) => {
            setSignature(event.target.value.trim());
            setVerified(null);
          }}
          className="font-mono text-xs break-all"
          data-testid="extension-signature"
        />
      </Field>
      {verified && manifest ? (
        <div
          className="rounded-lg px-3 py-1 faint-well animate-enter"
          data-testid="extension-verified"
        >
          <Facts>
            <Fact label={m.extensions_col_name()}>
              <span className="font-medium">{localizedText(manifest.name, manifest.id)}</span>
              <span className="font-mono text-xs text-muted-foreground">{manifest.id}</span>
            </Fact>
            <Fact label={m.extensions_col_version()}>
              <span className="font-mono">{manifest.version}</span>
              {verified.installedVersion ? (
                <Badge size="sm" tone="info">
                  {m.extensions_installed_version({ version: verified.installedVersion })}
                </Badge>
              ) : null}
            </Fact>
            <Fact label={m.extensions_signed_by()}>
              <span className="font-mono">{verified.key.publisher}</span>
              {verified.key.label ? (
                <span className="text-muted-foreground">{verified.key.label}</span>
              ) : null}
            </Fact>
            <Fact label={m.extensions_size()}>
              <span className="tabular-nums">{formatBytes(verified.size)}</span>
            </Fact>
            <Fact label={m.extensions_capabilities()}>
              <Names list={manifest.capabilities} />
            </Fact>
            <Fact label={m.extensions_hooks()}>
              <Names list={manifest.hooks} />
            </Fact>
          </Facts>
        </div>
      ) : null}
    </FormDialog>
  );
}

/** Add a trusted publisher key. */
function KeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useMutation({
    ...orpc.extensionKeys.add.mutationOptions(),
    meta: { invalidates: invalidates(), success: m.extensions_key_added },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.extensions_keys_add()}
      submitLabel={m.extensions_keys_add()}
      submitTestId="extension-key-submit"
      onSubmit={async (data) => {
        await add.mutateAsync({
          publisher: String(data.get("keyPublisher") ?? ""),
          key: String(data.get("keyValue") ?? ""),
          label: String(data.get("keyLabel") ?? ""),
        });
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="keyPublisher">{m.extensions_col_publisher()}</FieldLabel>
        <Input
          id="keyPublisher"
          name="keyPublisher"
          required
          maxLength={63}
          autoComplete="off"
          spellCheck={false}
          placeholder="example.org"
          className="font-mono"
          data-testid="extension-key-publisher"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="keyLabel">{m.extensions_key_label()}</FieldLabel>
        <Input id="keyLabel" name="keyLabel" maxLength={64} autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="keyValue">{m.extensions_key_value()}</FieldLabel>
        <Textarea
          id="keyValue"
          name="keyValue"
          required
          rows={4}
          spellCheck={false}
          placeholder='{"kty":"OKP","crv":"Ed25519","x":"…"}'
          className="font-mono text-xs break-all"
          data-testid="extension-key-value"
        />
      </Field>
    </FormDialog>
  );
}

function KeyMenu({ trusted }: { trusted: ExtensionKeyView }) {
  const remove = useMutation({
    ...orpc.extensionKeys.remove.mutationOptions(),
    meta: { invalidates: invalidates(), success: m.extensions_key_removed },
  });
  return (
    <ItemMenu
      testId="extension-key-actions"
      remove={{
        label: m.common_remove(),
        title: m.extensions_key_remove_confirm({ publisher: trusted.publisher }),
        onConfirm: () => remove.mutateAsync({ kid: trusted.kid }),
        testId: "extension-key-remove",
      }}
    />
  );
}

/** The publisher keys whose signatures the console accepts (none by default). */
function KeysPanel() {
  const keys = useQuery(orpc.extensionKeys.list.queryOptions());
  const [adding, setAdding] = React.useState(false);
  const addKey = useOpenKey(adding);
  return (
    <Panel className="animate-enter" style={enterDelay(2)} data-testid="extension-keys">
      <PanelHeader>
        <PanelTitle>{m.extensions_keys_title()}</PanelTitle>
        <PanelAction>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAdding(true)}
            data-testid="extension-key-add"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.extensions_keys_add()}
          </Button>
        </PanelAction>
      </PanelHeader>
      <PanelContent>
        <QueryView
          query={keys}
          empty={<EmptyState compact icon={SquareLock02Icon} title={m.extensions_keys_empty()} />}
        >
          {(list) => (
            <ul className="divide-y divide-edge">
              {list.map((trusted, index) => (
                <li
                  key={trusted.kid}
                  className="flex min-h-12 items-center gap-3 py-2 animate-enter"
                  style={enterDelay(index)}
                  data-testid="extension-key"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-mono font-medium">{trusted.publisher}</span>
                      {trusted.label ? (
                        <span className="text-muted-foreground">{trusted.label}</span>
                      ) : null}
                    </span>
                    <code
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={trusted.kid}
                    >
                      {trusted.kid}
                    </code>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    <TimeAgo at={trusted.createdAt} />
                  </span>
                  <KeyMenu trusted={trusted} />
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </PanelContent>
      <KeyDialog key={`key-${addKey}`} open={adding} onOpenChange={setAdding} />
    </Panel>
  );
}

function VersionRow({
  detail,
  version,
}: {
  detail: ExtensionDetail;
  version: ExtensionDetail["versions"][number];
}) {
  const meta = { invalidates: invalidates(), success: m.common_saved };
  const activate = useMutation({ ...orpc.extensions.activate.mutationOptions(), meta });
  const remove = useMutation({ ...orpc.extensions.deleteVersion.mutationOptions(), meta });
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2" data-testid="extension-version">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{version.version}</span>
          {version.active ? (
            <Badge size="sm" tone="success">
              {m.extensions_version_active()}
            </Badge>
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDateTime(version.uploadedAt)} · {formatBytes(version.size)}
        </span>
      </div>
      {version.active ? null : (
        <>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="secondary" data-testid="extension-version-activate">
                {m.extensions_version_activate()}
              </Button>
            }
            title={m.extensions_version_activate_confirm({ version: version.version })}
            confirmLabel={m.extensions_version_activate()}
            onConfirm={() => activate.mutateAsync({ id: detail.id, version: version.version })}
          />
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" data-testid="extension-version-delete">
                {m.common_delete()}
              </Button>
            }
            destructive
            title={m.extensions_version_delete_confirm({ version: version.version })}
            confirmLabel={m.common_delete()}
            onConfirm={() => remove.mutateAsync({ id: detail.id, version: version.version })}
          />
        </>
      )}
    </li>
  );
}

/** The sidecar's state a node reports (version 1.1), if any. */
function sidecarState(node: NodeExtensionState): string | null {
  const sidecar = node.details.sidecar;
  if (typeof sidecar !== "object" || sidecar === null) return null;
  const state = (sidecar as Record<string, unknown>).state;
  return typeof state === "string" && state ? state : null;
}

function NodeRow({ node }: { node: NodeExtensionState }) {
  const sidecar = sidecarState(node);
  return (
    <li
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
      data-testid="extension-node"
    >
      <span className="min-w-0 flex-1 truncate font-medium">{node.nodeName}</span>
      {node.version ? (
        <span className="font-mono text-xs text-muted-foreground">{node.version}</span>
      ) : null}
      {node.faults > 0 || node.trips > 0 ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {m.extensions_node_faults({ faults: node.faults, trips: node.trips })}
        </span>
      ) : null}
      {sidecar ? (
        <Badge size="sm" tone="neutral" data-testid="extension-node-sidecar">
          {m.extensions_node_sidecar({ state: sidecar })}
        </Badge>
      ) : null}
      <NodeState state={node.state} />
      {node.message ? (
        <span className="w-full font-mono text-xs break-all text-destructive">{node.message}</span>
      ) : null}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

/** The global configuration of an extension, from its manifest's schema. */
function GlobalConfig({ detail }: { detail: ExtensionDetail }) {
  const schema = detail.manifest.config.global;
  const [draft, setDraft] = React.useState<ConfigDraft>(() => configDraft(schema, detail.config));
  const [error, setError] = React.useState<string | null>(null);
  const update = useMutation({
    ...orpc.extensions.update.mutationOptions(),
    meta: { invalidates: invalidates(), success: m.common_saved },
  });
  return (
    <form
      className="flex flex-col"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await update.mutateAsync({ id: detail.id, config: configFromDraft(schema, draft) });
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
      data-testid="extension-global-config"
    >
      <FieldGroup>
        <SchemaForm schema={schema} draft={draft} onChange={setDraft} idPrefix="extension-global" />
        {error ? <FieldError className="animate-in fade-in">{error}</FieldError> : null}
        <Button
          type="submit"
          className="self-start"
          disabled={update.isPending}
          data-testid="extension-global-save"
        >
          {update.isPending ? <Spinner /> : null}
          {m.common_save()}
        </Button>
      </FieldGroup>
    </form>
  );
}

function DetailBody({ detail, onClose }: { detail: ExtensionDetail; onClose: () => void }) {
  const update = useMutation({
    ...orpc.extensions.update.mutationOptions(),
    meta: { invalidates: invalidates(), toastError: true },
  });
  const uninstall = useMutation({
    ...orpc.extensions.uninstall.mutationOptions(),
    meta: { invalidates: invalidates(), success: m.extensions_uninstalled },
  });
  const rotate = useMutation({
    ...orpc.extensions.rotateSecret.mutationOptions(),
    meta: { invalidates: invalidates(), success: m.extensions_secret_rotated },
  });
  const name = localizedText(detail.name, detail.id);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Facts>
        <Fact label={m.extensions_col_version()}>
          <span className="font-mono">{detail.version}</span>
        </Fact>
        <Fact label={m.extensions_col_publisher()}>
          <span className="font-mono">{detail.publisher}</span>
        </Fact>
        {detail.manifest.description ? (
          <Fact label={m.extensions_description()}>
            {localizedText(detail.manifest.description)}
          </Fact>
        ) : null}
        {detail.manifest.homepage ? (
          <Fact label={m.extensions_homepage()}>
            <a
              href={detail.manifest.homepage}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-sm font-mono text-[13px] text-primary-ink underline-offset-4 outline-none focus-ring hover:underline"
            >
              {detail.manifest.homepage}
            </a>
          </Fact>
        ) : null}
        <Fact label={m.extensions_capabilities()}>
          <Names list={detail.manifest.capabilities} />
        </Fact>
        <Fact label={m.extensions_hooks()}>
          <Names list={detail.manifest.hooks} />
        </Fact>
        <Fact label={m.extensions_digest()}>
          <code className="font-mono text-xs" title={detail.sha256}>
            {detail.sha256.slice(0, 16)}…
          </code>
        </Fact>
        {detail.manifest.secret ? (
          <Fact label={m.extensions_secret()}>
            <span className="tabular-nums" data-testid="extension-secret-version">
              {m.extensions_secret_version({ version: detail.secretVersion })}
            </span>
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="secondary" data-testid="extension-secret-rotate">
                  {m.extensions_secret_rotate()}
                </Button>
              }
              title={m.extensions_secret_rotate_confirm({ name })}
              confirmLabel={m.extensions_secret_rotate()}
              onConfirm={() => rotate.mutateAsync({ id: detail.id })}
            />
          </Fact>
        ) : null}
      </Facts>
      <Section title={m.extensions_settings()}>
        <FieldGroup>
          <SwitchField
            id="extension-enabled"
            label={m.extensions_enabled()}
            checked={detail.enabled}
            disabled={update.isPending}
            onCheckedChange={(enabled) => update.mutate({ id: detail.id, enabled })}
            className="self-start"
            testId="extension-detail-enabled"
          />
          <Field>
            <FieldLabel htmlFor="extension-failure-mode">{m.extensions_failure_mode()}</FieldLabel>
            <OptionSelect
              id="extension-failure-mode"
              value={detail.failureMode}
              options={[
                { value: "open", label: m.extensions_failure_open() },
                { value: "closed", label: m.extensions_failure_closed() },
              ]}
              onChange={(failureMode) => update.mutate({ id: detail.id, failureMode })}
              disabled={update.isPending}
              testId="extension-failure-mode"
            />
          </Field>
        </FieldGroup>
      </Section>
      {hasConfigFields(detail.manifest.config.global) ? (
        <Section title={m.extensions_config()}>
          <GlobalConfig key={detail.updatedAt} detail={detail} />
        </Section>
      ) : null}
      <Section title={m.extensions_versions()}>
        <ul className="divide-y divide-edge rounded-lg text-sm faint-well">
          {detail.versions.map((version) => (
            <VersionRow key={version.version} detail={detail} version={version} />
          ))}
        </ul>
      </Section>
      <Section title={m.extensions_col_nodes()}>
        {detail.nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ul className="divide-y divide-edge rounded-lg text-sm faint-well">
            {detail.nodes.map((node) => (
              <NodeRow key={node.nodeId} node={node} />
            ))}
          </ul>
        )}
      </Section>
      <Section title={m.extensions_col_sites()}>
        {detail.siteList.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {detail.siteList.map((site) => (
              <Badge key={site.id} size="sm" tone="neutral">
                {site.name}
              </Badge>
            ))}
          </div>
        )}
      </Section>
      <ConfirmDialog
        trigger={
          <Button
            variant="secondary"
            className="self-start text-destructive"
            data-testid="extension-uninstall"
          >
            {m.extensions_uninstall()}
          </Button>
        }
        destructive
        title={m.extensions_uninstall_confirm({ name })}
        note={m.extensions_uninstall_note()}
        confirmLabel={m.extensions_uninstall()}
        onConfirm={async () => {
          await uninstall.mutateAsync({ id: detail.id });
          onClose();
        }}
      />
    </div>
  );
}

/** An extension's page as a sheet: facts, settings, configuration, versions, nodes and sites. */
function ExtensionSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery(orpc.extensions.get.queryOptions({ input: { id } }));
  const name = detail.data ? localizedText(detail.data.name, id) : id;
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent
        side="right"
        className="w-[min(40rem,100vw)]!"
        data-testid="extension-detail"
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="min-w-0 break-all">{name}</span>
            <span className="w-full truncate font-mono text-xs font-normal text-muted-foreground">
              {id}
            </span>
          </span>
        }
      >
        <QueryView
          query={detail}
          notFound={<EmptyState compact icon={PuzzleIcon} title={m.extensions_gone()} />}
        >
          {(data) => <DetailBody detail={data} onClose={onClose} />}
        </QueryView>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * The System page's Extensions tab: the kill switch, installed extensions (each opens its sheet)
 * and the trusted publisher keys. `installOpen` is the page's "install extension" dialog.
 */
export function ExtensionsPanel({
  installOpen,
  onInstallOpenChange,
}: {
  installOpen: boolean;
  onInstallOpenChange: (open: boolean) => void;
}) {
  const extensions = useQuery(orpc.extensions.list.queryOptions());
  const installKey = useOpenKey(installOpen);
  const sheet = useDialogState<string>();
  const columns = React.useMemo<Columns<ExtensionSummary>>(
    () => [
      {
        id: "name",
        stack: "lead",
        header: () => m.extensions_col_name(),
        cell: ({ row }) => (
          <button
            type="button"
            className={cn(rowLinkButton, "flex min-w-0 flex-col items-start gap-0.5")}
            onClick={() => sheet.show(row.original.id)}
            data-testid="extension-open"
            {...rowLink}
          >
            <span className="font-medium">{localizedText(row.original.name, row.original.id)}</span>
            <span className="font-mono text-xs text-muted-foreground">{row.original.id}</span>
          </button>
        ),
      },
      {
        id: "status",
        stack: "aside",
        header: () => m.sites_col_status(),
        cell: ({ row }) => <ExtensionStatus extension={row.original} />,
      },
      {
        id: "version",
        header: () => m.extensions_col_version(),
        cell: ({ row }) => <span className="font-mono">{row.original.version}</span>,
      },
      {
        id: "publisher",
        header: () => m.extensions_col_publisher(),
        cell: ({ row }) => <span className="font-mono">{row.original.publisher}</span>,
      },
      {
        id: "nodes",
        header: () => m.extensions_col_nodes(),
        cell: ({ row }) => (
          <span className="tabular-nums" title={m.extensions_nodes_loaded()}>
            {row.original.nodesLoaded}
          </span>
        ),
      },
      {
        id: "sites",
        header: () => m.extensions_col_sites(),
        cell: ({ row }) => <span className="tabular-nums">{row.original.sites}</span>,
      },
      {
        id: "enabled",
        header: () => m.extensions_enabled(),
        cell: ({ row }) => <EnabledSwitch extension={row.original} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ItemMenu testId="extension-actions">
              <DropdownMenuItem onClick={() => sheet.show(row.original.id)}>
                {m.extensions_open()}
              </DropdownMenuItem>
            </ItemMenu>
          </div>
        ),
      },
    ],
    [sheet.show],
  );
  return (
    <div className="flex flex-col gap-6">
      <KillSwitch />
      <QueryView
        query={extensions}
        empty={
          <EmptyState icon={PuzzleIcon} title={m.extensions_empty()}>
            <Button onClick={() => onInstallOpenChange(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.extensions_install()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          <DataTable
            data={list}
            columns={columns}
            getRowId={(e) => e.id}
            testId="extensions-table"
            pinFirstColumn
          />
        )}
      </QueryView>
      <KeysPanel />
      <InstallDialog
        key={`install-${installKey}`}
        open={installOpen}
        onOpenChange={onInstallOpenChange}
        onInstalled={(id) => sheet.show(id)}
      />
      {sheet.open && sheet.value ? (
        <ExtensionSheet
          key={sheet.key}
          id={sheet.value}
          onClose={() => sheet.onOpenChange(false)}
        />
      ) : null}
    </div>
  );
}
