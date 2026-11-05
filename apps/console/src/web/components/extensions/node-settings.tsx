import {
  type ExtensionDetail,
  type ExtensionNodeSettings,
  type ExtensionNodeSettingsView,
  extensionNodeSettings,
  extensionRequiredFeatures,
} from "@edgeweir/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/arc/button/button";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { Input } from "@/components/arc/input/input";
import { Textarea } from "@/components/arc/textarea/textarea";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/layout/form";
import { Spinner } from "@/components/layout/spinner";
import { LinkButton } from "@/components/link-button";
import { SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

type ListenerDraft = { enabled: boolean; port: string; bind: string; allow: string };
type TargetMode = "all" | "selected" | "none";

function TargetNodes({
  detail,
  clusterIds,
}: {
  detail: ExtensionDetail;
  clusterIds: string[] | null;
}) {
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: {} }),
    refetchInterval: 10_000,
    meta: { background: true },
  });
  const required = extensionRequiredFeatures(detail.manifest);
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="extension-target-nodes">
      <h3 className="text-sm font-medium">{m.extensions_node_compatibility()}</h3>
      <QueryView query={nodes}>
        {(list) => {
          const targets = list.filter(
            (node) => clusterIds === null || clusterIds.includes(node.clusterId),
          );
          return targets.length === 0 ? (
            <EmptyState compact title={m.nodes_empty_title()} />
          ) : (
            <ul className="divide-y divide-edge rounded-lg text-sm faint-well">
              {targets.map((node) => {
                const missing = required.filter(
                  (feature) => !node.supportedFeatures.includes(feature),
                );
                const unknown = !node.lastSeenAt || !node.online;
                const inactive = node.status === "disabled";
                const report = detail.nodes.find((state) => state.nodeId === node.id);
                const reportedListeners = report?.details.listeners;
                const listenerFailures =
                  missing.length === 0 &&
                  typeof reportedListeners === "object" &&
                  reportedListeners !== null
                    ? Object.entries(reportedListeners).flatMap(([name, value]) => {
                        if (typeof value !== "object" || value === null) return [];
                        const listener = value as { state?: unknown; message?: unknown };
                        return listener.state === "failed"
                          ? [
                              {
                                name,
                                message:
                                  typeof listener.message === "string" ? listener.message : "",
                              },
                            ]
                          : [];
                      })
                    : [];
                const failed =
                  node.applyState === "failed" ||
                  report?.state === "failed" ||
                  report?.state === "incompatible" ||
                  listenerFailures.length > 0;
                return (
                  <li
                    key={node.id}
                    className="flex min-w-0 flex-col gap-2 p-3"
                    data-testid="extension-target-node"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-all font-medium">{node.name}</span>
                      <StatusDot
                        tone={
                          unknown || inactive
                            ? "idle"
                            : failed
                              ? "bad"
                              : missing.length
                                ? "warn"
                                : "idle"
                        }
                      >
                        {unknown
                          ? m.extensions_node_unknown()
                          : inactive
                            ? m.extensions_node_disabled()
                            : failed
                              ? m.extensions_node_failed()
                              : missing.length
                                ? m.extensions_node_unsupported()
                                : m.extensions_node_features_reported()}
                      </StatusDot>
                    </div>
                    {!unknown && missing.length ? (
                      <span className="font-mono text-xs break-all">{missing.join(", ")}</span>
                    ) : null}
                    {failed && (node.applyMessage || report?.message) ? (
                      <span className="text-xs break-all text-destructive">
                        {node.applyMessage || report?.message}
                      </span>
                    ) : null}
                    {listenerFailures.map((listener) => (
                      <span key={listener.name} className="text-xs break-all text-destructive">
                        {listener.name}
                        {listener.message ? `: ${listener.message}` : ""}
                      </span>
                    ))}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 font-mono text-xs text-muted-foreground">
                        <p>
                          {m.extensions_node_revision({
                            applied: node.appliedRevision,
                            target: node.targetRevision ?? "—",
                          })}
                        </p>
                        {node.appliedContentHash ? (
                          <p className="break-all">
                            {m.revisions_col_hash()}: {node.appliedContentHash}
                          </p>
                        ) : null}
                      </div>
                      <LinkButton
                        to="/clusters"
                        search={{ cluster: node.clusterId, node: node.id }}
                        size="sm"
                        variant="secondary"
                      >
                        {m.nodes_details()}
                      </LinkButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </QueryView>
    </section>
  );
}

function NodeSettingsForm({
  detail,
  initial,
  footer,
}: {
  detail: ExtensionDetail;
  initial: ExtensionNodeSettingsView;
  footer: HTMLDivElement | null;
}) {
  const declarations = detail.manifest.listeners ?? [];
  const [listeners, setListeners] = React.useState<Record<string, ListenerDraft>>(() =>
    Object.fromEntries(
      declarations.map((listener) => {
        const saved = initial.settings.listeners[listener.name];
        return [
          listener.name,
          {
            enabled: saved != null,
            port: saved ? String(saved.port) : "",
            bind: saved?.bind ?? "0.0.0.0",
            allow: saved?.allow.join("\n") ?? "",
          },
        ];
      }),
    ),
  );
  const [mode, setMode] = React.useState<TargetMode>(() =>
    initial.settings.clusterIds == null
      ? "all"
      : initial.settings.clusterIds.length
        ? "selected"
        : "none",
  );
  const [selected, setSelected] = React.useState(initial.settings.clusterIds ?? []);
  const snapshot = JSON.stringify({ listeners, mode, selected });
  const [saved, setSaved] = React.useState(snapshot);
  const [checked, setChecked] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{ path: string; message: string } | null>(null);
  const form = React.useRef<HTMLFormElement>(null);
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const update = useMutation({
    ...orpc.extensions.updateNodeSettings.mutationOptions(),
    meta: { invalidates: [orpc.extensions.key()], success: m.common_saved },
  });
  const check = useMutation(orpc.extensions.checkNodeSettings.mutationOptions());
  const pending = update.isPending || check.isPending;
  React.useLayoutEffect(() => {
    if (pending || !error?.path) return;
    const field = form.current?.querySelector<HTMLElement>(`[data-node-field="${error.path}"]`);
    const details = field?.closest("details");
    if (details) details.open = true;
    field?.focus();
  }, [error, pending]);
  const clusterIds = mode === "all" ? null : mode === "none" ? [] : selected;
  const change = (name: string, patch: Partial<ListenerDraft>) =>
    setListeners((current) => ({
      ...current,
      [name]: { ...(current[name] as ListenerDraft), ...patch },
    }));
  const showError = (path: string, message: string) => {
    setError({ path, message });
  };
  const submit = async (save: boolean) => {
    if (!form.current?.reportValidity()) return;
    setError(null);
    setChecked(null);
    if (mode === "selected" && selected.length === 0) {
      showError("clusterIds", m.extensions_node_select_cluster());
      return;
    }
    const settings: ExtensionNodeSettings = {
      clusterIds,
      listeners: Object.fromEntries(
        Object.entries(listeners).map(([name, listener]) => [
          name,
          listener.enabled
            ? {
                port: Number(listener.port),
                bind: listener.bind.trim(),
                allow: listener.allow.split(/[\s,]+/).filter(Boolean),
              }
            : null,
        ]),
      ),
    };
    const parsed = extensionNodeSettings(detail.manifest, []).safeParse(settings);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.slice(0, 3).join(".") ?? "";
      const message = path.endsWith(".port")
        ? m.extensions_node_invalid_port()
        : path.endsWith(".bind")
          ? m.extensions_node_invalid_bind()
          : m.extensions_node_invalid_allow();
      showError(path, message);
      return;
    }
    try {
      const input = { id: detail.id, settings: parsed.data };
      if (save) {
        await update.mutateAsync(input);
        setSaved(snapshot);
      } else {
        await check.mutateAsync(input);
      }
      setChecked(snapshot);
    } catch (err) {
      const data = (err as { data?: { path?: string; port?: number } })?.data;
      const conflict = Object.entries(listeners).find(
        ([, listener]) => listener.enabled && Number(listener.port) === data?.port,
      );
      showError(
        data?.path?.split(".").slice(0, 3).join(".") ??
          (conflict ? `listeners.${conflict[0]}.port` : ""),
        errorMessage(err),
      );
    }
  };
  const fieldError = (path: string) =>
    error?.path === path ? (
      <FieldError id={`extension-node-error-${path}`}>{error.message}</FieldError>
    ) : null;
  return (
    <form
      id="extension-node-settings"
      ref={form}
      className="flex min-w-0 flex-col gap-4"
      data-testid="extension-node-settings"
      onInvalidCapture={(event) => {
        const details = (event.target as HTMLElement).closest("details");
        if (details) details.open = true;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(true);
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="extension-node-targets">{m.extensions_node_targets()}</FieldLabel>
          <OptionSelect<TargetMode>
            id="extension-node-targets"
            value={mode}
            options={[
              { value: "all", label: m.extensions_node_targets_all() },
              { value: "selected", label: m.extensions_node_targets_selected() },
              { value: "none", label: m.extensions_node_targets_none() },
            ]}
            onChange={setMode}
            disabled={pending}
            testId="extension-node-targets"
          />
          <div hidden={mode !== "selected"}>
            <QueryView
              query={clusters}
              empty={<EmptyState compact title={m.clusters_empty_title()} />}
            >
              {(list) => (
                <div
                  className="flex flex-col gap-2 pt-2"
                  data-node-field="clusterIds"
                  tabIndex={-1}
                >
                  {list.map((cluster) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control
                    <label key={cluster.id} className="flex min-h-11 items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected.includes(cluster.id)}
                        disabled={pending}
                        onCheckedChange={(on) =>
                          setSelected((ids) =>
                            on ? [...ids, cluster.id] : ids.filter((id) => id !== cluster.id),
                          )
                        }
                      />
                      <span className="min-w-0 break-all">{cluster.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </QueryView>
          </div>
          {fieldError("clusterIds")}
        </Field>
        {declarations.length === 0 ? (
          <EmptyState compact title={m.extensions_node_no_listeners()} />
        ) : null}
        {declarations.map((declaration) => {
          const name = declaration.name;
          const listener = listeners[name] as ListenerDraft;
          const prefix = `listeners.${name}`;
          return (
            <fieldset
              key={name}
              className="flex min-w-0 flex-col gap-3 rounded-lg border border-edge p-3"
              data-testid={`extension-listener-${name}`}
            >
              <legend className="px-1 font-mono text-sm">{name}</legend>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{m.extensions_node_methods()}</dt>
                <dd className="font-mono break-all">{declaration.methods.join(", ")}</dd>
                <dt className="text-muted-foreground">{m.extensions_node_max_body()}</dt>
                <dd>{declaration.max_body}</dd>
                <dt className="text-muted-foreground">{m.extensions_node_default_port()}</dt>
                <dd>{declaration.default_port}</dd>
              </dl>
              <SwitchField
                id={`extension-listener-${name}-enabled`}
                label={m.extensions_node_listener_enabled()}
                checked={listener.enabled}
                onCheckedChange={(enabled) => change(name, { enabled })}
                disabled={pending}
                testId={`extension-listener-${name}-enabled`}
              />
              <div hidden={!listener.enabled} className="flex min-w-0 flex-col gap-3">
                <Field>
                  <FieldLabel htmlFor={`extension-listener-${name}-port`}>
                    {m.extensions_node_port()}
                  </FieldLabel>
                  <Input
                    id={`extension-listener-${name}-port`}
                    type="number"
                    inputMode="numeric"
                    min={1024}
                    max={65535}
                    step={1}
                    required
                    disabled={!listener.enabled || pending}
                    value={listener.port}
                    onChange={(event) => change(name, { port: event.target.value })}
                    className="w-32 tabular-nums"
                    data-node-field={`${prefix}.port`}
                    aria-invalid={error?.path === `${prefix}.port` || undefined}
                    aria-describedby={
                      error?.path === `${prefix}.port`
                        ? `extension-node-error-${prefix}.port`
                        : undefined
                    }
                  />
                  {fieldError(`${prefix}.port`)}
                </Field>
                <details className="min-w-0" data-testid={`extension-listener-${name}-binding`}>
                  <summary className="min-h-11 cursor-pointer rounded-md py-2 text-sm outline-none focus-ring">
                    {m.extensions_node_binding()}
                  </summary>
                  <div className="flex min-w-0 flex-col gap-3 pt-2">
                    <Field>
                      <FieldLabel htmlFor={`extension-listener-${name}-bind`}>
                        {m.extensions_node_bind()}
                      </FieldLabel>
                      <Input
                        id={`extension-listener-${name}-bind`}
                        required
                        disabled={!listener.enabled || pending}
                        value={listener.bind}
                        onChange={(event) => change(name, { bind: event.target.value })}
                        className="font-mono"
                        data-node-field={`${prefix}.bind`}
                        aria-invalid={error?.path === `${prefix}.bind` || undefined}
                        aria-describedby={
                          error?.path === `${prefix}.bind`
                            ? `extension-node-error-${prefix}.bind`
                            : undefined
                        }
                      />
                      {fieldError(`${prefix}.bind`)}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`extension-listener-${name}-allow`}>
                        {m.extensions_node_allow()}
                      </FieldLabel>
                      <Textarea
                        id={`extension-listener-${name}-allow`}
                        rows={5}
                        required
                        disabled={!listener.enabled || pending}
                        value={listener.allow}
                        onChange={(event) => change(name, { allow: event.target.value })}
                        spellCheck={false}
                        className="max-h-64 min-w-0 overflow-auto font-mono text-xs"
                        data-node-field={`${prefix}.allow`}
                        aria-invalid={error?.path === `${prefix}.allow` || undefined}
                        aria-describedby={
                          error?.path === `${prefix}.allow`
                            ? `extension-node-error-${prefix}.allow`
                            : undefined
                        }
                      />
                      {fieldError(`${prefix}.allow`)}
                    </Field>
                  </div>
                </details>
              </div>
            </fieldset>
          );
        })}
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => void submit(false)}
          data-testid="extension-node-check"
        >
          {check.isPending ? <Spinner /> : null}
          {m.extensions_node_check()}
        </Button>
        {checked === snapshot ? (
          <StatusDot tone="good">{m.extensions_node_checked()}</StatusDot>
        ) : null}
      </div>
      <TargetNodes detail={detail} clusterIds={clusterIds} />
      {footer
        ? createPortal(
            <SaveBar
              form="extension-node-settings"
              dirty={snapshot !== saved}
              pending={pending}
              error={error?.message ?? null}
              testId="extension-node-save"
              errorTestId="extension-node-error"
              className="border-t-0 px-0 pt-0"
            />,
            footer,
          )
        : null}
    </form>
  );
}

export function NodeSettings({
  detail,
  footer,
}: {
  detail: ExtensionDetail;
  footer: HTMLDivElement | null;
}) {
  const settings = useQuery(
    orpc.extensions.nodeSettings.queryOptions({ input: { id: detail.id } }),
  );
  return (
    <QueryView query={settings}>
      {(initial) => (
        <NodeSettingsForm key={detail.version} detail={detail} initial={initial} footer={footer} />
      )}
    </QueryView>
  );
}
