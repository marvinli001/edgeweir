import { Sparkline as AppicaSparkline, SparklineChart } from "@appica/ui-react/sparkline";
import { AppicaScope } from "@/components/appica/scope";

/** Compact trend line for stat cards. */
export function Sparkline({
  data,
  label,
  color = "var(--primary)",
  height = 36,
}: {
  data: number[];
  label: string;
  color?: string;
  height?: number;
}) {
  if (data.length < 2) return null;
  return (
    <AppicaScope>
      <AppicaSparkline data={data} color={color}>
        <SparklineChart variant="area" height={height} aria-label={label} />
      </AppicaSparkline>
    </AppicaScope>
  );
}
