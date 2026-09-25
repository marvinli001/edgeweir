import type { AnalyticsRange } from "@edgeweir/contract";
import * as React from "react";
import {
  Bar,
  BarChart,
  type BarShapeProps,
  CartesianGrid,
  Line,
  LineChart,
  Rectangle,
  XAxis,
  YAxis,
} from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { SERIES_COLORS, spansDays, timeTicks } from "@/lib/analytics";
import { formatAxisTime, formatChartTime } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** One plotted series; `key` is its field in the chart rows. */
export interface Series {
  key: string;
  label: string;
  color: string;
}

/** A point in time; a null value (a ratio with nothing to divide) leaves a gap. */
export type ChartRow = { time: string } & Record<string, number | string | null>;

/**
 * Keeps each item on the color it first got while the dialog is open, so a refetch that reorders
 * the leaders never repaints the survivors. New items take the lowest free slot.
 */
export function useSeriesSlots(ids: string[]): Map<string, number> {
  const previous = React.useRef(new Map<string, number>());
  const key = ids.join("\n");
  return React.useMemo(() => {
    const list = key ? key.split("\n") : [];
    const next = new Map<string, number>();
    for (const id of list) {
      const slot = previous.current.get(id);
      if (slot !== undefined) next.set(id, slot);
    }
    const used = new Set(next.values());
    let free = 0;
    for (const id of list) {
      if (next.has(id)) continue;
      while (used.has(free)) free++;
      next.set(id, free);
      used.add(free);
    }
    previous.current = next;
    return next;
  }, [key]);
}

export function seriesColor(slot: number | undefined): string {
  return SERIES_COLORS[(slot ?? 0) % SERIES_COLORS.length] ?? SERIES_COLORS[0];
}

/** Legend above a chart: each series' key, name and figure. Keys mirror the marks. */
export function SeriesLegend({
  series,
  mark,
}: {
  series: (Series & { value: string })[];
  mark: "line" | "bar";
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 pt-2 text-xs" data-testid="series-legend">
      {series.map((s) => (
        <li key={s.key} className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "shrink-0",
              mark === "line" ? "h-0.5 w-3 rounded-full" : "size-2.5 rounded-[3px]",
            )}
            style={{ backgroundColor: s.color }}
          />
          <span className="max-w-48 truncate text-muted-foreground">{s.label}</span>
          <span className="font-medium tabular-nums text-foreground">{s.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Every series at the hovered position; values lead, names follow. */
function SeriesTooltip({
  row,
  series,
  format,
}: {
  row: ChartRow | undefined;
  series: Series[];
  format: (value: number) => string;
}) {
  if (!row) return null;
  return (
    <div className="grid min-w-48 gap-1.5 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10">
      <span className="text-muted-foreground">{formatChartTime(row.time)}</span>
      {series.map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
          <span className="max-w-48 truncate text-muted-foreground">{s.label}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums text-foreground">
            {typeof row[s.key] === "number" ? format(row[s.key] as number) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function chartConfig(series: Series[]): ChartConfig {
  return Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
}

const axisProps = {
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
  className: "tabular-nums",
} as const;

/** Time axis with ticks on clock boundaries (hours, days) rather than wherever points fall. */
function TimeAxis({ data, range }: { data: ChartRow[]; range: AnalyticsRange }) {
  const days = spansDays(range);
  return (
    <XAxis
      dataKey="time"
      {...axisProps}
      ticks={timeTicks(
        data.map((row) => row.time),
        range,
      )}
      interval="preserveStartEnd"
      minTickGap={24}
      tickFormatter={(value: string) => formatAxisTime(value, days)}
    />
  );
}

/** One thin line per series with a time axis, value ticks and hairlines. */
export function LinesChart({
  data,
  series,
  format,
  range,
  domain,
}: {
  data: ChartRow[];
  series: Series[];
  format: (value: number) => string;
  range: AnalyticsRange;
  /** Fixed value axis (ratios); otherwise from zero to fit the data. */
  domain?: [number, number];
}) {
  const reducedMotion = useReducedMotion();
  return (
    <ChartContainer config={chartConfig(series)} className="aspect-auto h-64 w-full">
      <LineChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <TimeAxis data={data} range={range} />
        <YAxis
          {...axisProps}
          tickCount={5}
          width="auto"
          domain={domain ?? [0, "auto"]}
          tickFormatter={(value: number) => format(value)}
        />
        <ChartTooltip
          isAnimationActive={false}
          cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 3", strokeWidth: 1 }}
          content={({ active, payload }) =>
            active ? (
              <SeriesTooltip
                row={payload?.[0]?.payload as ChartRow | undefined}
                series={series}
                format={format}
              />
            ) : null
          }
        />
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            type="linear"
            stroke={s.color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)", fill: s.color }}
            isAnimationActive={!reducedMotion}
            animationDuration={600}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

/**
 * Stacked bars, first series at the baseline. Segments are parted by a hairline of the card
 * surface and only the top of each stack is rounded.
 */
export function StackedBarsChart({
  data,
  series,
  format,
  range,
}: {
  data: ChartRow[];
  series: Series[];
  format: (value: number) => string;
  range: AnalyticsRange;
}) {
  const reducedMotion = useReducedMotion();
  // The topmost non-empty segment of each bar, which gets the rounded end.
  const rows = data.map((row) => ({
    ...row,
    top: series.findLast((s) => Number(row[s.key] ?? 0) > 0)?.key ?? "",
  }));
  return (
    <ChartContainer config={chartConfig(series)} className="aspect-auto h-64 w-full">
      <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <TimeAxis data={data} range={range} />
        <YAxis
          {...axisProps}
          tickCount={5}
          width="auto"
          domain={[0, "auto"]}
          tickFormatter={(value: number) => format(value)}
        />
        <ChartTooltip
          isAnimationActive={false}
          cursor={{ fill: "var(--muted)", opacity: 0.6 }}
          content={({ active, payload }) =>
            active ? (
              <SeriesTooltip
                row={payload?.[0]?.payload as ChartRow | undefined}
                series={[...series].reverse()}
                format={format}
              />
            ) : null
          }
        />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="stack"
            fill={s.color}
            stroke="var(--card)"
            strokeWidth={1}
            isAnimationActive={!reducedMotion}
            animationDuration={500}
            shape={(props: BarShapeProps) => (
              <Rectangle
                {...props}
                radius={(props.payload as { top?: string }).top === s.key ? [3, 3, 0, 0] : 0}
              />
            )}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
