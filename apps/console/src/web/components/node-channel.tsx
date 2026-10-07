import { nodeChannelInput } from "@edgeweir/contract";
import { NodeChannelCheckStatus, UrlScopeBadge } from "@/components/node-enrollment";
import { SafetyNote } from "@/components/safety-note";
import { SettingSourceBadge, SettingsCard } from "@/components/settings-card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * System page card: the node channel URL install commands give nodes and probes, where it comes from,
 * and the console's own check of it.
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
        </Field>
      )}
    </SettingsCard>
  );
}
