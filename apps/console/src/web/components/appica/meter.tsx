import { Meter as AppicaMeter, MeterProgress } from "@appica/ui-react/meter";
import { AppicaScope } from "@/components/appica/scope";
import { cn } from "@/lib/utils";

/**
 * A thin gauge (appica Meter on Base UI's meter role) colored by zone: the zone of `optimum` is
 * good, the next one a warning, the far one an error. By default low values are good (load); pass
 * `optimum={max}` when high values are (nodes online), and `low` to give the bottom its own zone.
 * Pair it with the value as text.
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
  return (
    <AppicaScope>
      <AppicaMeter
        value={value}
        max={max}
        low={low}
        high={high}
        optimum={optimum}
        aria-label={label}
        statusClassNames={{
          optimum: "bg-state-good",
          suboptimum: "bg-state-warn",
          invalid: "bg-destructive",
          default: "bg-primary",
        }}
        className={cn("w-full", className)}
      >
        {/* The track is a shallow well, like a progress bar's. */}
        <MeterProgress className="h-1.5 rounded-full bg-well seg-well" />
      </AppicaMeter>
    </AppicaScope>
  );
}
