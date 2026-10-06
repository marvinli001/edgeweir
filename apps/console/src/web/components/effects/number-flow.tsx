/*
 * Rolling digits for headline numbers (Number Flow, MIT, Maxwell Barvian). Formatting follows the
 * console's language; the digits stand still under reduced motion (Number Flow checks it).
 */
import NumberFlow, { type Format, NumberFlowGroup } from "@number-flow/react";
import type * as React from "react";
import { getLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export { NumberFlowGroup };

export function FlowNumber({
  value,
  format,
  prefix,
  suffix,
  className,
  trend,
}: {
  value: number;
  format?: Format;
  prefix?: string;
  suffix?: string;
  className?: string;
  /** Which way digits roll: up on increases (1), always down (-1), or by sign (0). */
  trend?: -1 | 0 | 1;
}): React.JSX.Element {
  return (
    <NumberFlow
      value={value}
      locales={getLocale()}
      format={format}
      prefix={prefix}
      suffix={suffix}
      trend={trend}
      respectMotionPreference
      willChange
      className={cn("readout", className)}
    />
  );
}

/**
 * A value with a unit picked by size (1 000 steps, like formatBytes): the number rolls, the unit
 * follows it as a suffix.
 */
export function FlowScaled({
  value,
  units,
  className,
}: {
  value: number;
  units: readonly string[];
  className?: string;
}) {
  let index = 0;
  let scaled = value;
  while (Math.abs(scaled) >= 1000 && index < units.length - 1) {
    scaled /= 1000;
    index++;
  }
  return (
    <FlowNumber
      value={scaled}
      format={{ maximumFractionDigits: scaled < 100 ? 2 : 1 }}
      suffix={` ${units[index]}`}
      className={className}
    />
  );
}
