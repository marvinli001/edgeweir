import { type NodeChannel, nodeChannelInput } from "@edgeweir/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { DisabledHint } from "@/components/disabled-hint";
import { Field, FieldLabel } from "@/components/layout/form";
import { Spinner } from "@/components/layout/spinner";
import { NodeChannelCheckStatus, UrlScopeBadge } from "@/components/node-enrollment";
import { SafetyNote } from "@/components/safety-note";
import { SettingSourceBadge, SettingsCard } from "@/components/settings-card";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** Who may still connect with a name or through the entry, or that nobody does. */
function Usage({ nodes, probes }: { nodes: number; probes: number }) {
  if (!nodes && !probes)
    return <span className="text-muted-foreground">{m.system_node_channel_unused()}</span>;
  return (
    <span className="tabular-nums text-muted-foreground">
      {m.system_node_channel_usage({ nodes, probes })}
    </span>
  );
}

/**
 * How far nodes and probes moved to the URL, and what earlier URLs left behind: their names in
 * the certificate and the WebSocket entry, removable once no node or probe uses them.
 */
function NodeChannelMigration({ value: saved }: { value: NodeChannel }) {
  // Nodes and probes move on their own: keep the counts current.
  const live = useQuery({
    ...orpc.settings.nodeChannel.queryOptions(),
    refetchInterval: 15_000,
    meta: { background: true },
  });
  const value = live.data ?? saved;
  const meta = (success: () => string) => ({
    invalidates: [orpc.settings.key()],
    success,
    toastError: true,
  });
  const remove = useMutation({
    ...orpc.settings.removeNodeChannelName.mutationOptions(),
    meta: meta(m.system_node_channel_removed),
  });
  const close = useMutation({
    ...orpc.settings.closeNodeChannelWebSocket.mutationOptions(),
    meta: meta(m.system_node_channel_websocket_closed),
  });
  const { adoption, previousNames, webSocket } = value;
  if (!adoption.nodes && !adoption.probes && !previousNames.length && !webSocket.closable)
    return null;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="node-channel-migration">
      {adoption.nodes || adoption.probes ? (
        <p
          className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums"
          data-testid="node-channel-adoption"
        >
          {adoption.nodes ? (
            <span>
              {m.system_node_channel_nodes_switched({
                current: adoption.nodesCurrent,
                total: adoption.nodes,
              })}
            </span>
          ) : null}
          {adoption.probes ? (
            <span>
              {m.system_node_channel_probes_switched({
                current: adoption.probesCurrent,
                total: adoption.probes,
              })}
            </span>
          ) : null}
        </p>
      ) : null}
      {previousNames.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{m.system_node_channel_previous()}</span>
          <ul className="flex flex-col gap-1" data-testid="node-channel-previous">
            {previousNames.map((entry) => {
              const used = entry.nodes + entry.probes > 0;
              const busy = remove.isPending && remove.variables?.name === entry.name;
              return (
                <li
                  key={entry.name}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-well px-3 py-1.5"
                  data-testid="node-channel-previous-name"
                  data-name={entry.name}
                >
                  <span className="min-w-0 font-mono break-all">{entry.name}</span>
                  <Usage nodes={entry.nodes} probes={entry.probes} />
                  <DisabledHint reason={used && m.system_node_channel_in_use()} className="ml-auto">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={used || remove.isPending}
                      onClick={() => remove.mutate({ name: entry.name })}
                      data-testid="node-channel-remove-name"
                    >
                      {busy ? <Spinner /> : null}
                      {m.common_remove()}
                    </Button>
                  </DisabledHint>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {webSocket.closable ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-well px-3 py-1.5"
          data-testid="node-channel-websocket"
        >
          <span>{m.system_node_channel_websocket()}</span>
          <Usage nodes={webSocket.nodes} probes={webSocket.probes} />
          <DisabledHint
            reason={webSocket.nodes + webSocket.probes > 0 && m.system_node_channel_in_use()}
            className="ml-auto"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={webSocket.nodes + webSocket.probes > 0 || close.isPending}
              onClick={() => close.mutate({})}
              data-testid="node-channel-close-websocket"
            >
              {close.isPending ? <Spinner /> : null}
              {m.common_close()}
            </Button>
          </DisabledHint>
        </div>
      ) : null}
    </div>
  );
}

/**
 * System page card: the node channel URL install commands give nodes and probes (enrolled ones
 * move to it), where it comes from, the console's own check of it, and what earlier URLs left.
 */
export function NodeChannelCard() {
  return (
    <SettingsCard
      title={m.system_node_api_url()}
      className="animate-enter"
      style={{ animationDelay: "30ms" }}
      testId="node-channel-card"
      query={orpc.settings.nodeChannel.queryOptions()}
      mutation={orpc.settings.setNodeChannel.mutationOptions()}
      toDraft={(s) => ({ url: s.url })}
      toInput={(d) => ({ url: d.url.trim() })}
      check={(input) =>
        nodeChannelInput.safeParse(input).success ? null : m.system_node_channel_invalid()
      }
      // The system information, the check and install commands follow the URL.
      refresh={orpc.settings.key()}
      noValidate
      saveTestId="node-channel-save"
    >
      {({ value, draft, set, error }) => (
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="node-channel-url" className="flex items-center gap-2">
            {m.system_node_channel_url()}
            <SettingSourceBadge source={value.source} testId="node-channel-source" />
          </FieldLabel>
          <Input
            id="node-channel-url"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={draft.url}
            onChange={(event) => set({ url: event.target.value })}
            placeholder={value.effectiveUrl}
            aria-invalid={error ? true : undefined}
            className="font-mono text-sm"
            data-testid="node-channel-url"
          />
          <div className="flex flex-wrap items-center gap-2">
            <UrlScopeBadge url={value.effectiveUrl} testId="node-api-url-scope" />
            <NodeChannelCheckStatus />
          </div>
          {draft.url.trim() !== value.url ? (
            <SafetyNote data-testid="node-channel-note">{m.system_node_channel_note()}</SafetyNote>
          ) : null}
          <NodeChannelMigration value={value} />
        </Field>
      )}
    </SettingsCard>
  );
}
