import { Meter as AppicaMeter, MeterProgress } from "@appica/ui-react/meter";
import { AppicaScope } from "@/components/appica/scope";

/** A 0–100 gauge bar (e.g. cache hit ratio). */
export function Meter({ value, label }: { value: number; label: string }) {
  return (
    <AppicaScope>
      <AppicaMeter value={value} min={0} max={100} aria-label={label} className="w-full">
        <MeterProgress />
      </AppicaMeter>
    </AppicaScope>
  );
}
