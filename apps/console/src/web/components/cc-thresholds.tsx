import {
  CC_PRESETS,
  type CcThresholds,
  CHALLENGE_TYPES,
  type ChallengeType,
} from "@edgeweir/contract";
import { OptionSelect } from "@/components/form-select";
import { PresetSelect, usePreset } from "@/components/preset-select";
import { SwitchField } from "@/components/site/fields";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatNumber, m } from "@/lib/i18n";
import { challengeLabel } from "@/lib/protection";

/** Numeric thresholds of a CC policy with their input ranges, in display order. */
const NUMBERS = [
  ["windowSeconds", () => m.cc_window(), 5, 60, "window"],
  ["siteQps", () => m.cc_site_qps(), 0, 1_000_000, "site-qps"],
  ["urlQps", () => m.cc_url_qps(), 0, 1_000_000, "url-qps"],
  ["ipQps", () => m.cc_ip_qps(), 0, 1_000_000, "ip-qps"],
  ["ipBanSeconds", () => m.cc_ip_ban(), 60, 86400, "ip-ban"],
  ["originErrorPercent", () => m.cc_origin_error(), 0, 100, "origin-error"],
  ["originErrorMinRequests", () => m.cc_origin_min(), 0, 1_000_000, "origin-min"],
  ["escalateAfterSeconds", () => m.cc_escalate(), 1, 3600, "escalate"],
  ["cooldownSeconds", () => m.cc_cooldown(), 1, 86400, "cooldown"],
] as const;

type NumberKey = (typeof NUMBERS)[number][0];

/** Form state of the thresholds: numbers stay text while editing. */
export type CcDraft = {
  maxLevel: ChallengeType;
  highPowInsteadOfCaptcha: boolean;
} & Record<NumberKey, string>;

export function toCcDraft(value: CcThresholds): CcDraft {
  return {
    maxLevel: value.maxLevel,
    highPowInsteadOfCaptcha: value.highPowInsteadOfCaptcha,
    ...(Object.fromEntries(NUMBERS.map(([key]) => [key, String(value[key])])) as Record<
      NumberKey,
      string
    >),
  };
}

export function fromCcDraft(draft: CcDraft): CcThresholds {
  return {
    maxLevel: draft.maxLevel,
    highPowInsteadOfCaptcha: draft.highPowInsteadOfCaptcha,
    ...(Object.fromEntries(NUMBERS.map(([key]) => [key, Number(draft[key])])) as Record<
      NumberKey,
      number
    >),
  };
}

/**
 * The thresholds of a CC policy or of the platform template: a preset (its values read out in a
 * well), or each field.
 */
export function CcThresholdFields({
  prefix,
  value,
  onChange,
  disabled,
}: {
  /** Element ids and test ids start with it, e.g. "cc" → "cc-site-qps". */
  prefix: string;
  value: CcDraft;
  onChange: (value: CcDraft) => void;
  disabled?: boolean;
}) {
  const preset = usePreset(CC_PRESETS, fromCcDraft(value), (thresholds) =>
    onChange(toCcDraft(thresholds)),
  );
  // Columns follow the width the fields get (a full-width card: four), not the window.
  return (
    <div className="@container/cc">
      <div className="grid gap-4 @[18rem]/cc:grid-cols-2 @2xl/cc:grid-cols-3 @4xl/cc:grid-cols-4">
        {/* The two selects take a whole row until there are three columns (long level names). */}
        <div className="col-span-full @2xl/cc:col-span-1">
          <PresetSelect
            id={`${prefix}-preset`}
            value={preset.choice}
            disabled={disabled}
            onChange={preset.choose}
          />
        </div>
        {preset.choice === "custom" ? (
          <CustomThresholds prefix={prefix} value={value} onChange={onChange} disabled={disabled} />
        ) : (
          <PresetReadout thresholds={fromCcDraft(value)} />
        )}
      </div>
    </div>
  );
}

/** What a preset sets, as label-over-value readouts in a well (the fields show for custom). */
function PresetReadout({ thresholds }: { thresholds: CcThresholds }) {
  const item = (label: string, value: string, figures?: boolean) => (
    <div key={label} className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={figures ? "readout text-sm font-medium" : "text-sm font-medium"}>{value}</dd>
    </div>
  );
  return (
    <dl className="col-span-full grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl px-4 py-3 sunk-well @2xl/cc:grid-cols-3 @4xl/cc:grid-cols-4">
      {item(m.cc_max_level(), challengeLabel(thresholds.maxLevel))}
      {NUMBERS.map(([key, label]) => item(label(), formatNumber(thresholds[key]), true))}
      {item(m.cc_high_pow(), thresholds.highPowInsteadOfCaptcha ? m.rules_on() : m.rules_off())}
    </dl>
  );
}

function CustomThresholds({
  prefix,
  value,
  onChange,
  disabled,
}: {
  prefix: string;
  value: CcDraft;
  onChange: (value: CcDraft) => void;
  disabled?: boolean;
}) {
  const levelId = `${prefix}-max-level`;
  return (
    <>
      <Field data-disabled={disabled || undefined} className="col-span-full @2xl/cc:col-span-1">
        <FieldLabel htmlFor={levelId}>{m.cc_max_level()}</FieldLabel>
        <OptionSelect
          id={levelId}
          value={value.maxLevel}
          disabled={disabled}
          testId={levelId}
          options={CHALLENGE_TYPES.map((type) => ({ value: type, label: challengeLabel(type) }))}
          onChange={(maxLevel) => onChange({ ...value, maxLevel: maxLevel as ChallengeType })}
        />
      </Field>
      {NUMBERS.map(([key, label, min, max, id]) => (
        // Inputs sit at the foot of their grid cell, so a row lines up when a label wraps.
        <Field key={key} data-disabled={disabled || undefined} className="justify-end">
          <FieldLabel htmlFor={`${prefix}-${id}`}>{label()}</FieldLabel>
          <Input
            id={`${prefix}-${id}`}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            required
            disabled={disabled}
            value={value[key]}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            className="tabular-nums"
            data-testid={`${prefix}-${id}`}
          />
        </Field>
      ))}
      <SwitchField
        id={`${prefix}-high-pow`}
        label={m.cc_high_pow()}
        checked={value.highPowInsteadOfCaptcha}
        disabled={disabled}
        testId={`${prefix}-high-pow`}
        className="col-span-full @2xl/cc:col-span-1 [&>label]:whitespace-normal"
        onCheckedChange={(highPowInsteadOfCaptcha) =>
          onChange({ ...value, highPowInsteadOfCaptcha })
        }
      />
    </>
  );
}
