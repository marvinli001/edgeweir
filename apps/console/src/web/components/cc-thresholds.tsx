import {
  CC_PRESETS,
  type CcThresholds,
  CHALLENGE_TYPES,
  type ChallengeType,
} from "@edgeweir/contract";
import { FormSelect } from "@/components/form-select";
import { PresetSelect, usePreset } from "@/components/preset-select";
import { NumberField, SwitchField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
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

/** The thresholds of a CC policy or of the platform template: a preset, or each field. */
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
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <PresetSelect
        id={`${prefix}-preset`}
        value={preset.choice}
        disabled={disabled}
        onChange={preset.choose}
      />
      {preset.choice === "custom" ? (
        <CustomThresholds prefix={prefix} value={value} onChange={onChange} disabled={disabled} />
      ) : null}
    </div>
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
  return (
    <>
      <FormSelect
        id={`${prefix}-max-level`}
        label={m.cc_max_level()}
        value={value.maxLevel}
        disabled={disabled}
        testId={`${prefix}-max-level`}
        options={CHALLENGE_TYPES.map((type) => ({ value: type, label: challengeLabel(type) }))}
        onChange={(maxLevel) => onChange({ ...value, maxLevel: maxLevel as ChallengeType })}
      />
      {NUMBERS.map(([key, label, min, max, id]) => (
        <NumberField
          key={key}
          id={`${prefix}-${id}`}
          label={label()}
          value={value[key]}
          min={min}
          max={max}
          step={1}
          required
          disabled={disabled}
          testId={`${prefix}-${id}`}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
      <SwitchField
        id={`${prefix}-high-pow`}
        label={m.cc_high_pow()}
        checked={value.highPowInsteadOfCaptcha}
        disabled={disabled}
        testId={`${prefix}-high-pow`}
        onCheckedChange={(highPowInsteadOfCaptcha) =>
          onChange({ ...value, highPowInsteadOfCaptcha })
        }
      />
    </>
  );
}
