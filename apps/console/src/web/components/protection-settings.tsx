import { CHALLENGE_TYPES, type ChallengeType, EVENT_RETENTION_RANGE } from "@edgeweir/contract";
import type * as React from "react";
import { CcThresholdFields, fromCcDraft, toCcDraft } from "@/components/cc-thresholds";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OptionSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { Badge } from "@/components/ui/badge";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { challengeLabel } from "@/lib/protection";
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
      className={cn(GRID_CARD, className)}
      style={style}
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
                  <Badge variant="destructive" data-testid="platform-under-attack-on">
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
                    ...value,
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
                options={CHALLENGE_TYPES.map((type) => ({
                  value: type,
                  label: challengeLabel(type),
                }))}
                onChange={(type) => set({ underAttackChallenge: type as ChallengeType })}
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
