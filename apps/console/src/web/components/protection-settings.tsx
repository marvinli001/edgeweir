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
import { cn } from "@/lib/utils";

/**
 * A settings card in a grid of settings cards: it fills its grid cell, and its save row stays at
 * the bottom when a neighbour in the same row is taller (the card's form and fields grow).
 */
export const GRID_CARD = "[&>form]:flex-1";

/** The settings of a card as rows split by hairlines (SettingRow). */
export function SettingRows({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col divide-y divide-border">{children}</div>;
}

/** One setting: its label (and a state mark) on the left, its control on the right. */
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
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        {aside}
      </div>
      {/* Stays on the right when a long label pushes it onto a line of its own. */}
      <div className="ml-auto flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/** A whole number of a setting row, kept as text while editing; figures line up on the right. */
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
      className="w-32 text-right"
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
      indentSave={false}
      title={m.protection_settings_title()}
      className={cn(GRID_CARD, className)}
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
      contentClassName="flex-1"
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
                className="w-44"
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
      contentClassName="flex flex-col gap-4"
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
