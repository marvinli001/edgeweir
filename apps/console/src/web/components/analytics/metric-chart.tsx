import { LineChart } from "@/components/arc/line-chart/line-chart";
import { formatChartTime } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface MetricDatum {
  time: string;
  value: number | null;
}

/**
 * One series as a brand line over a faint wash (Arc's line chart). With `axis`, hairlines and
 * value ticks on the right; without, the area runs to the panel's edges. Buckets without a value
 * leave gaps. Hovering reads a point.
 */
export function MetricChart({
  data,
  label,
  format,
  axis = false,
  domain,
  onClick,
  className,
}: {
  data: MetricDatum[];
  label: string;
  format: (value: number) => string;
  axis?: boolean;
  domain?: [number, number];
  onClick?: () => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card's own button opens the same details; this only widens the pointer target
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div className={cn("flex h-full w-full flex-col justify-end", className)} onClick={onClick}>
      <LineChart
        data={data.map((point) => ({
          key: point.time,
          label: formatChartTime(point.time),
          values: { value: point.value },
        }))}
        series={[{ key: "value", label, color: "var(--arc-series-1)", area: true }]}
        label={label}
        height={axis ? 140 : 128}
        legend={false}
        axis={axis}
        curve="linear"
        domain={domain}
        formatValue={(value) => format(value)}
        formatTick={format}
      />
    </div>
  );
}
