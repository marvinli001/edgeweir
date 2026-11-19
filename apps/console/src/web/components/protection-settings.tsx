import {
  type ChallengeKind,
  EVENT_RETENTION_RANGE,
  type ProtectionSettings,
  type ProtectionSettingsView,
} from "@edgeweir/contract";
import type * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Input } from "@/components/arc/input/input";
import { Switch } from "@/components/arc/switch/switch";
import { CcThresholdFields, fromCcDraft, toCcDraft } from "@/components/cc-thresholds";
import {
  ChallengeProviderFields,
  fromProviderDraft,
  toProviderDraft,
} from "@/components/challenge-provider-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OptionSelect } from "@/components/form-select";
import { FieldLabel } from "@/components/layout/form";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { challengeKindOptions } from "@/lib/protection";

/** Labels stay with their controls as the card gains or loses field columns. */
export function SettingRows({ children }: { children: React.ReactNode }) {
  return <div className="form-grid items-end">{children}</div>;
}

/** One labelled setting with an optional state mark. */
export function SettingRow({
  htmlFor,
  label,
  aside,
  children,
}: {
  /** The control's id. */
  htmlFor: string;
  label: string;
  /** A mark beside the label, e.g. the state a switch is in. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        {aside}
      </div>
      <div className="flex min-h-(--arc-control-height-md) min-w-0 items-center">{children}</div>
    </div>
  );
}

/** A whole number kept as text while editing. */
export function SettingNumber({
  id,
  value,
  onChange,
  min,
  max,
  testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  testId: string;
}) {
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      required
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full tabular-nums"
      data-testid={testId}
    />
  );
}

/** The platform protection without the provider, which only its own card saves. */
const withoutProvider = ({ provider: _provider, ...rest }: ProtectionSettingsView) =>
  rest satisfies ProtectionSettings;

/** Platform Under Attack (switched right away, after a confirmation) and event retention. */
export function ProtectionSettingsCard({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <SettingsCard
      title={m.protection_settings_title()}
      className={className}
      style={style}
      query={orpc.settings.protection.queryOptions()}
      mutation={orpc.settings.setProtection.mutationOptions()}
      toDraft={(s) => ({
        underAttackChallenge: s.underAttackChallenge,
        eventRetentionDays: String(s.eventRetentionDays),
      })}
      toInput={(d, s) => ({
        ...withoutProvider(s),
        underAttackChallenge: d.underAttackChallenge,
        eventRetentionDays: Number(d.eventRetentionDays),
      })}
      saveTestId="protection-settings-save"
    >
      {({ value, draft, set, pending, apply }) => {
        const turningOn = !value.underAttack;
        return (
          <SettingRows>
            <SettingRow
              htmlFor="platform-under-attack"
              label={m.protection_platform_under_attack()}
              aside={
                value.underAttack ? (
                  <Badge size="sm" tone="danger" data-testid="platform-under-attack-on">
                    {m.protection_on()}
                  </Badge>
                ) : null
              }
            >
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
                    ...withoutProvider(value),
                    underAttack: turningOn,
                    underAttackChallenge: draft.underAttackChallenge,
                  })
                }
              />
            </SettingRow>
            <SettingRow htmlFor="platform-under-attack-type" label={m.rules_challenge_type()}>
              <OptionSelect
                id="platform-under-attack-type"
                value={draft.underAttackChallenge}
                testId="platform-under-attack-type"
                options={challengeKindOptions(true)}
                onChange={(type) => set({ underAttackChallenge: type as ChallengeKind })}
              />
            </SettingRow>
            <SettingRow htmlFor="protection-retention" label={m.protection_retention()}>
              <SettingNumber
                id="protection-retention"
                value={draft.eventRetentionDays}
                onChange={(eventRetentionDays) => set({ eventRetentionDays })}
                min={EVENT_RETENTION_RANGE.min}
                max={EVENT_RETENTION_RANGE.max}
                testId="protection-retention"
              />
            </SettingRow>
          </SettingRows>
        );
      }}
    </SettingsCard>
  );
}

/** The global interactive provider: the widget of every site that follows it. */
export function InteractiveProviderCard({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <SettingsCard
      title={m.challenge_provider_title()}
      className={className}
      style={style}
      testId="interactive-provider-card"
      query={orpc.settings.protection.queryOptions()}
      mutation={orpc.settings.setProtection.mutationOptions()}
      toDraft={(s) => toProviderDraft(s.provider)}
      toInput={(d, s) => ({ ...withoutProvider(s), provider: fromProviderDraft(d) })}
      layout="grid"
      saveTestId="interactive-provider-save"
    >
      {({ value, draft, set }) => (
        <ChallengeProviderFields
          id="global-provider"
          draft={draft}
          saved={value.provider}
          onChange={set}
        />
      )}
    </SettingsCard>
  );
}

/** The CC thresholds of sites that follow the default template. */
export function CcTemplateCard({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <SettingsCard
      title={m.cc_template_title()}
      className={className}
      style={style}
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
  );
}
