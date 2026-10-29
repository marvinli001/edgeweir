import { Meter as MeterPrimitive } from "@base-ui/react/meter";
import { cn } from "@/lib/utils";

/**
 * A thin gauge (Base UI's meter role) colored by zone: the zone of `optimum` is good, the next one
 * a warning, the far one an error. By default low values are good (load); pass `optimum={max}`
 * when high values are (nodes online), and `low` to give the bottom its own zone. Pair it with
 * the value as text. In forced colors the fill turns Highlight (index.css).
 */
export function Meter({
  value,
  max = 100,
  low = 0,
  high = 80,
  optimum = 0,
  label,
  className,
}: {
  value: number;
  max?: number;
  low?: number;
  high?: number;
  optimum?: number;
  label: string;
  className?: string;
}) {
  const zone = (v: number) => (v < low ? 0 : v <= high ? 1 : 2);
  const distance = Math.abs(zone(Math.min(Math.max(value, 0), max)) - zone(optimum));
  const fill = distance === 0 ? "bg-success" : distance === 1 ? "bg-warning" : "bg-destructive";
  return (
    <MeterPrimitive.Root
      value={value}
      max={max}
      aria-label={label}
      className={cn("w-full", className)}
    >
      <MeterPrimitive.Track className="block h-1.5 overflow-hidden rounded-full bg-well">
        <MeterPrimitive.Indicator
          data-slot="meter-indicator"
          className={cn("block h-full rounded-full transition-[width] duration-300", fill)}
        />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  );
}
