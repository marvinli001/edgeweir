import * as React from "react";
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
 * The hover trail: everything right of the pointer dims, so the line up to the read point stands
 * out; a dashed rule marks the point itself. Recharts passes the plot box and the cursor points.
 */
function TrailCursor(props: {
  points?: { x: number; y: number }[];
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}) {
  const x = props.points?.[0]?.x;
  const { left = 0, top = 0, width = 0, height = 0 } = props;
  if (x === undefined) return null;
  return (
    <g pointerEvents="none">
      <rect
        x={x}
        y={top - 12}
        width={Math.max(0, left + width - x)}
        height={height + 12}
        fill="var(--card)"
        fillOpacity={0.55}
      />
      <line
        x1={x}
        x2={x}
        y1={top}
        y2={top + height}
        stroke="var(--muted-foreground)"
        strokeDasharray="3 3"
        strokeWidth={1}
      />
    </g>
  );
}

/**
 * One series as a lit line over a gradient wash (a soft glow on the line in dark mode). With
 * `axis`, horizontal hairlines and value ticks on the right; without, the area runs to the card's
 * edges. Hovering reads a point and dims what comes after it.
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
  const reducedMotion = useReducedMotion();
  const fill = `metric-fill-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const config = { value: { label, color: "var(--metric)" } } satisfies ChartConfig;
  return (
    <ChartContainer
      config={config}
      data-glow=""
      className={cn("aspect-auto h-full w-full", className)}
    >
      <AreaChart
        data={data}
        margin={{ top: axis ? 12 : 6, right: 0, bottom: 0, left: 0 }}
        onClick={onClick}
      >
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.26} />
            <stop offset="72%" stopColor="var(--color-value)" stopOpacity={0.04} />
            <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {axis ? (
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
        ) : null}
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
          cursor={<TrailCursor />}
          content={({ active, payload, label: time }) => {
            const value = payload?.[0]?.value;
            if (!active || typeof value !== "number") return null;
            return (
              <div className="grid min-w-44 gap-1.5 rounded-xl bg-popover px-3 py-2 text-xs text-popover-foreground shadow-elev-3">
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
          fill={`url(#${fill})`}
          fillOpacity={1}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
          isAnimationActive={!reducedMotion}
          animationDuration={600}
        />
      </AreaChart>
    </ChartContainer>
  );
}
