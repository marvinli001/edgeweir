import { Sparkline as AppicaSparkline, SparklineChart } from "@appica/ui-react/sparkline";
import { AppicaScope } from "@/components/appica/scope";
import { cn } from "@/lib/utils";

/**
 * A small trend line (appica Sparkline, pure SVG) in a token color: the metric blue for history
 * (the default), the signal only for live series, which opt in with `tone="signal"`. Decorative:
 * the value beside it carries the number.
 */
export function Sparkline({
  data,
  tone = "metric",
  height = 36,
  fill = true,
  className,
}: {
  data: number[];
  tone?: "signal" | "metric";
  height?: number;
  fill?: boolean;
  className?: string;
}) {
  return (
    <AppicaScope>
      <AppicaSparkline
        data={data}
        color={tone === "signal" ? "var(--signal)" : "var(--metric)"}
        className={cn("pointer-events-none", className)}
        aria-hidden
      >
        <SparklineChart
          variant="line"
          fill={fill}
          curve={0.35}
          height={height}
          strokeWidth={1.5}
          indicator={false}
        />
      </AppicaSparkline>
    </AppicaScope>
  );
}
