import { MAX_ORIGIN_ALLOWED_CIDRS, normalizeCidr } from "@edgeweir/contract";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const lines = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * System page card: special-purpose addresses (private, loopback, link-local...) that
 * origins may use anyway. Saving publishes a new revision for every cluster.
 */
export function OriginAllowListCard() {
  return (
    <SettingsCard
      title={m.system_origin_allow_list_title()}
      className="animate-enter"
      style={{ animationDelay: "40ms" }}
      testId="origin-allow-list-card"
      query={orpc.settings.originAllowList.queryOptions()}
      mutation={orpc.settings.setOriginAllowList.mutationOptions()}
      toDraft={(list) => ({ text: list.cidrs.join("\n") })}
      toInput={(d) => ({ cidrs: lines(d.text) })}
      check={({ cidrs }) => {
        const invalid = cidrs.find((entry) => normalizeCidr(entry) === null);
        if (invalid !== undefined) return m.system_origin_allow_list_invalid({ value: invalid });
        if (cidrs.length > MAX_ORIGIN_ALLOWED_CIDRS)
          return m.system_origin_allow_list_too_many({ max: MAX_ORIGIN_ALLOWED_CIDRS });
        return null;
      }}
      noValidate
      contentClassName="flex flex-col gap-3"
      saveTestId="origin-allow-list-save"
      errorTestId="origin-allow-list-error"
    >
      {({ draft, set, error }) => (
        <>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="origin-allow-list">
              {m.system_origin_allow_list_label()}
            </FieldLabel>
            <Textarea
              id="origin-allow-list"
              value={draft.text}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => set({ text: event.target.value })}
              placeholder={"10.0.0.0/8\n172.18.0.0/16\nfd00::/8"}
              aria-invalid={error ? true : undefined}
              className="min-h-28 font-mono text-sm"
              data-testid="origin-allow-list"
            />
          </Field>
          <SafetyNote>{m.system_origin_allow_list_note()}</SafetyNote>
        </>
      )}
    </SettingsCard>
  );
}
