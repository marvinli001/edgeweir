import { CodeBlock } from "@/components/copy-button";
import { Field, FieldLabel } from "@/components/layout/form";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { SwitchField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** OAuth 2.1 wants HTTPS, loopback consoles (clients on the same machine) aside. */
function secureUrl(url: string) {
  const { protocol, hostname } = new URL(url);
  return (
    protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase())
  );
}

/** System page card: the MCP server for AI clients (ADR-0076), off by default. */
export function McpSettingsCard() {
  return (
    <SettingsCard
      title={m.system_mcp_title()}
      className="animate-enter"
      style={{ animationDelay: "300ms" }}
      query={orpc.mcp.settings.queryOptions()}
      mutation={orpc.mcp.setSettings.mutationOptions()}
      toDraft={(s) => ({ enabled: s.enabled })}
      toInput={(d) => ({ enabled: d.enabled })}
      saveTestId="mcp-settings-save"
    >
      {({ value, draft, set }) => (
        <>
          <SwitchField
            id="mcp-enabled"
            label={m.system_mcp_enabled()}
            checked={draft.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
            className="self-start"
            testId="mcp-enabled"
          />
          {value.enabled ? (
            <Field className="animate-enter">
              <FieldLabel>{m.system_mcp_url()}</FieldLabel>
              <CodeBlock value={value.url} testId="mcp-url" />
            </Field>
          ) : null}
          {secureUrl(value.url) ? null : (
            <SafetyNote data-testid="mcp-https">{m.system_mcp_https()}</SafetyNote>
          )}
        </>
      )}
    </SettingsCard>
  );
}
