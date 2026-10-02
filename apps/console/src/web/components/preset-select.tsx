import { matchPreset, PRESET_LEVELS, type PresetLevel } from "@edgeweir/contract";
import * as React from "react";
import { FormSelect } from "@/components/form-select";
import { m } from "@/lib/i18n";

/** A preset level, or custom values. */
export type PresetChoice = PresetLevel | "custom";

const presetLabel = (choice: PresetChoice) =>
  ({
    loose: m.preset_loose,
    standard: m.preset_standard,
    strict: m.preset_strict,
    custom: m.preset_custom,
  })[choice]();

/**
 * The preset the values match, or custom when they match none or the operator chose to edit
 * them; choosing a preset applies its values.
 */
export function usePreset<T extends object>(
  presets: Record<PresetLevel, T>,
  values: T,
  apply: (preset: T) => void,
): { choice: PresetChoice; choose: (choice: PresetChoice) => void } {
  const [custom, setCustom] = React.useState(false);
  const matched = matchPreset(presets, values);
  return {
    choice: custom || !matched ? "custom" : matched,
    choose: (choice) => {
      setCustom(choice === "custom");
      if (choice !== "custom") apply(presets[choice]);
    },
  };
}

/** Loose, standard, strict or custom; the fields show only for custom. */
export function PresetSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  /** Element id and test id. */
  id: string;
  value: PresetChoice;
  onChange: (choice: PresetChoice) => void;
  disabled?: boolean;
}) {
  return (
    <FormSelect
      id={id}
      label={m.preset_label()}
      value={value}
      disabled={disabled}
      testId={id}
      options={[...PRESET_LEVELS, "custom" as const].map((choice) => ({
        value: choice,
        label: presetLabel(choice),
      }))}
      onChange={(choice) => onChange(choice as PresetChoice)}
    />
  );
}
