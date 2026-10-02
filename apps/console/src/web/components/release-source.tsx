import { type ReleaseSource, releaseSourceInput } from "@edgeweir/contract";
import { SettingsCard } from "@/components/settings-card";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const sourceLabel: Record<ReleaseSource["source"], () => string> = {
  setting: m.system_release_source_setting,
  environment: m.system_release_source_environment,
  default: m.system_release_source_default,
};

/** Admin card: the mirror node upgrades read release manifests from. */
export function ReleaseSourceCard() {
  return (
    <SettingsCard
      title={m.system_release_title()}
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
      query={orpc.settings.releaseSource.queryOptions()}
      mutation={orpc.settings.setReleaseSource.mutationOptions()}
      toDraft={(s) => ({ url: s.url })}
      toInput={(d) => ({ url: d.url.trim() })}
      check={(input) =>
        releaseSourceInput.safeParse(input).success ? null : m.system_release_invalid()
      }
      noValidate
      saveTestId="release-source-save"
    >
      {({ value, draft, set, error }) => (
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="release-source" className="flex items-center gap-2">
            {m.system_release_url()}
            <Badge variant="secondary" data-testid="release-source-origin">
              {sourceLabel[value.source]()}
            </Badge>
          </FieldLabel>
          <Input
            id="release-source"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={draft.url}
            onChange={(event) => set({ url: event.target.value })}
            placeholder={value.effectiveUrl}
            aria-invalid={error ? true : undefined}
            className="font-mono text-sm"
            data-testid="release-source"
          />
        </Field>
      )}
    </SettingsCard>
  );
}
