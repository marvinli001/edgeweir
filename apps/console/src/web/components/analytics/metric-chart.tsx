import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { formatChartTime } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface MetricDatum {
  time: string;
  value: number | null;
}

/**
 * One series as a thin line over a 10% wash. With `axis`, horizontal hairlines and value ticks
 * on the right; without, the area runs to the card's edges. A crosshair tooltip reads each point.
 */
export function MetricChart({
  data,
  label,
  format,
  axis = false,
  domain,
  className,
}: {
  data: MetricDatum[];
  label: string;
  format: (value: number) => string;
  axis?: boolean;
  domain?: [number, number];
  className?: string;
}) {
  const reducedMotion = useReducedMotion();
  const config = { value: { label, color: "var(--metric)" } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className={cn("aspect-auto h-full w-full", className)}>
      <AreaChart data={data} margin={{ top: axis ? 12 : 6, right: 0, bottom: 0, left: 0 }}>
        {axis ? <CartesianGrid vertical={false} stroke="var(--border)" /> : null}
        <XAxis dataKey="time" hide />
        <YAxis
          hide={!axis}
          orientation="right"
          axisLine={false}
          tickLine={false}
          tickMargin={8}
          tickCount={4}
          width="auto"
          domain={domain ?? [0, "auto"]}
          tickFormatter={(value: number) => format(value)}
          className="tabular-nums"
        />
        <ChartTooltip
          isAnimationActive={false}
          cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 3", strokeWidth: 1 }}
          content={({ active, payload, label: time }) => {
            const value = payload?.[0]?.value;
            if (!active || typeof value !== "number") return null;
            return (
              <div className="grid min-w-44 gap-1.5 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10">
                <span className="text-muted-foreground">{formatChartTime(String(time))}</span>
                <div className="flex items-center gap-2">
                  <span className="h-0.5 w-3 shrink-0 rounded-full bg-metric" />
                  <span className="text-muted-foreground">{label}</span>
                  <span className="ml-auto pl-3 font-semibold tabular-nums text-foreground">
                    {format(value)}
                  </span>
                </div>
              </div>
            );
          }}
        />
        <Area
          dataKey="value"
          type="linear"
          stroke="var(--color-value)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          fill="var(--color-value)"
          fillOpacity={0.1}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          isAnimationActive={!reducedMotion}
          animationDuration={600}
        />
      </AreaChart>
    </ChartContainer>
  );
}
