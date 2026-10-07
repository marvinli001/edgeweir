import { CHALLENGE_TYPES, type ChallengeType, EVENT_RETENTION_RANGE } from "@edgeweir/contract";
import { CcThresholdFields, fromCcDraft, toCcDraft } from "@/components/cc-thresholds";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { NumberField } from "@/components/site/fields";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { challengeLabel } from "@/lib/protection";

/** Protection page cards: platform Under Attack, event retention and the CC template. */
export function ProtectionSettingsCards() {
  return (
    <>
      <SettingsCard
        title={m.protection_settings_title()}
        className="animate-enter"
        style={{ animationDelay: "160ms" }}
        query={orpc.settings.protection.queryOptions()}
        mutation={orpc.settings.setProtection.mutationOptions()}
        toDraft={(s) => ({
          underAttackChallenge: s.underAttackChallenge,
          eventRetentionDays: String(s.eventRetentionDays),
        })}
        toInput={(d, s) => ({
          ...s,
          underAttackChallenge: d.underAttackChallenge,
          eventRetentionDays: Number(d.eventRetentionDays),
        })}
        contentClassName="grid gap-4 sm:grid-cols-2"
        saveTestId="protection-settings-save"
      >
        {({ value, draft, set, pending, apply }) => {
          const turningOn = !value.underAttack;
          return (
            <>
              <Field orientation="horizontal" className="min-h-9 w-auto self-end">
                {/* Switched right away, with the challenge type of the form. */}
                <ConfirmDialog
                  trigger={
                    <Switch
                      id="platform-under-attack"
                      checked={value.underAttack}
                      disabled={pending}
                      data-testid="platform-under-attack"
                    />
                  }
                  destructive={turningOn}
                  title={
                    turningOn
                      ? m.protection_platform_on_confirm()
                      : m.protection_platform_off_confirm()
                  }
                  note={m.protection_platform_note()}
                  confirmLabel={turningOn ? m.protection_turn_on() : m.protection_turn_off()}
                  onConfirm={() =>
                    apply({
                      ...value,
                      underAttack: turningOn,
                      underAttackChallenge: draft.underAttackChallenge,
                    })
                  }
                />
                <FieldLabel htmlFor="platform-under-attack">
                  {m.protection_platform_under_attack()}
                </FieldLabel>
                {value.underAttack ? (
                  <Badge variant="destructive" data-testid="platform-under-attack-on">
                    {m.protection_on()}
                  </Badge>
                ) : null}
              </Field>
              <FormSelect
                id="platform-under-attack-type"
                label={m.rules_challenge_type()}
                value={draft.underAttackChallenge}
                testId="platform-under-attack-type"
                options={CHALLENGE_TYPES.map((type) => ({
                  value: type,
                  label: challengeLabel(type),
                }))}
                onChange={(type) => set({ underAttackChallenge: type as ChallengeType })}
              />
              <NumberField
                id="protection-retention"
                label={m.protection_retention()}
                value={draft.eventRetentionDays}
                onChange={(eventRetentionDays) => set({ eventRetentionDays })}
                min={EVENT_RETENTION_RANGE.min}
                max={EVENT_RETENTION_RANGE.max}
                step={1}
                required
                testId="protection-retention"
              />
            </>
          );
        }}
      </SettingsCard>
      <SettingsCard
        title={m.cc_template_title()}
        className="animate-enter"
        style={{ animationDelay: "180ms" }}
        query={orpc.settings.ccTemplate.queryOptions()}
        mutation={orpc.settings.setCcTemplate.mutationOptions()}
        toDraft={toCcDraft}
        toInput={fromCcDraft}
        contentClassName="flex flex-col gap-4"
        saveTestId="cc-template-save"
      >
        {({ draft, set }) => (
          <>
            <CcThresholdFields prefix="cc-template" value={draft} onChange={set} />
            <SafetyNote>{m.cc_per_node_note()}</SafetyNote>
          </>
        )}
      </SettingsCard>
    </>
  );
}
