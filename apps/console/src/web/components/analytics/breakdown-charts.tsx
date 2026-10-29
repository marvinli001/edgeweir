import type { AnalyticsRange } from "@edgeweir/contract";
import * as React from "react";
import { LineChart, type LineChartDatum } from "@/components/arc/line-chart/line-chart";
import { SERIES_COLORS, spansDays, timeTicks } from "@/lib/analytics";
import { formatAxisTime, formatChartTime, m } from "@/lib/i18n";
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

/** Chart points for the Arc line chart, with date labels on clock boundaries (hours, days). */
function chartData(rows: ChartRow[], keys: string[], range: AnalyticsRange): LineChartDatum[] {
  const ticks = new Set(
    timeTicks(
      rows.map((row) => row.time),
      range,
    ),
  );
  const days = spansDays(range);
  return rows.map((row) => ({
    key: row.time,
    label: formatChartTime(row.time),
    axisLabel: ticks.has(row.time) ? formatAxisTime(row.time, days) : undefined,
    values: Object.fromEntries(
      keys.map((key) => [key, typeof row[key] === "number" ? (row[key] as number) : null]),
    ),
  }));
}

/** An element's width, kept current (0 until measured). */
function useWidth<T extends HTMLElement>(): [React.RefCallback<T>, number] {
  const [width, setWidth] = React.useState(0);
  const ref = React.useCallback((element: T | null) => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The axis labels that fit side by side (like the line chart's): one per slot as wide as the
 * longest label, counted back from the latest so the newest always shows.
 */
function fittingLabels(points: LineChartDatum[], width: number): Set<number> {
  const labeled = points.flatMap((point, index) => (point.axisLabel ? [index] : []));
  if (!width) return new Set(labeled);
  const longest = Math.max(0, ...labeled.map((index) => points[index]?.axisLabel?.length ?? 0));
  const room = Math.max(2, Math.floor(width / Math.max(76, longest * 7 + 24)));
  const stride = Math.ceil(labeled.length / room);
  return new Set(labeled.reverse().filter((_, rank) => rank % stride === 0));
}

/** One thin line per series with a time axis, value ticks and hairlines. */
export function LinesChart({
  data,
  series,
  format,
  range,
  domain,
  label = m.chart_label(),
}: {
  data: ChartRow[];
  series: Series[];
  format: (value: number) => string;
  range: AnalyticsRange;
  /** Fixed value axis (ratios); otherwise from zero to fit the data. */
  domain?: [number, number];
  label?: string;
}) {
  return (
    <LineChart
      data={chartData(
        data,
        series.map((s) => s.key),
        range,
      )}
      series={series.map((s) => ({ key: s.key, label: s.label, color: s.color, area: false }))}
      label={label}
      height={232}
      legend={false}
      curve="linear"
      domain={domain}
      formatValue={(value) => format(value)}
      formatTick={format}
      className="px-4"
    />
  );
}

/** Clean steps for the value axis: four rows of 1, 2, 2.5 or 5 times a power of ten, from zero. */
function niceMax(high: number): number[] {
  const top = Math.max(high, 1);
  const magnitude = 10 ** Math.floor(Math.log10(top / 4));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((st) => st * 4 >= top) ?? top / 4;
  return [0, 1, 2, 3, 4].map((i) => Number((i * step).toPrecision(12)));
}

const PLOT_HEIGHT = 232;

/**
 * Stacked bars, first series at the baseline, in plain SVG on the chart tokens (Arc has no stacked
 * bar chart). Segments are parted by a hairline of the panel surface, hovering reads one bar, and
 * screen readers get the values as a table.
 */
export function StackedBarsChart({
  data,
  series,
  format,
  range,
  label = m.chart_label(),
}: {
  data: ChartRow[];
  series: Series[];
  format: (value: number) => string;
  range: AnalyticsRange;
  label?: string;
}) {
  const [active, setActive] = React.useState<number | null>(null);
  const totals = data.map((row) => series.reduce((sum, s) => sum + Number(row[s.key] ?? 0), 0));
  const ticks = niceMax(Math.max(0, ...totals));
  const max = ticks.at(-1) ?? 1;
  const y = (value: number) => PLOT_HEIGHT - (value / max) * PLOT_HEIGHT;
  const points = chartData(
    data,
    series.map((s) => s.key),
    range,
  );
  const width = 100 / Math.max(1, data.length);
  const row = active === null ? null : data[active];
  const [axisRef, axisWidth] = useWidth<HTMLDivElement>();
  const shown = React.useMemo(() => fittingLabels(points, axisWidth), [points, axisWidth]);
  return (
    <figure className="relative m-0 grid min-w-0 gap-2 px-4" aria-label={label}>
      <div className="grid grid-cols-[minmax(0,1fr)_48px]">
        <div
          className="relative"
          style={{ height: PLOT_HEIGHT }}
          onPointerLeave={() => setActive(null)}
          aria-hidden="true"
        >
          <svg className="block size-full overflow-visible" role="presentation">
            {ticks.slice(1).map((tick) => (
              <line
                key={tick}
                x1="0"
                x2="100%"
                y1={Math.round(y(tick)) + 0.5}
                y2={Math.round(y(tick)) + 0.5}
                className="stroke-grid"
              />
            ))}
            <line
              x1="0"
              x2="100%"
              y1={PLOT_HEIGHT - 0.5}
              y2={PLOT_HEIGHT - 0.5}
              className="stroke-axis"
            />
            {data.map((r, index) => {
              let base = 0;
              return (
                <g
                  key={r.time}
                  onPointerEnter={() => setActive(index)}
                  className={cn(active !== null && active !== index && "opacity-50")}
                >
                  <rect
                    x={`${index * width}%`}
                    width={`${width}%`}
                    y={0}
                    height={PLOT_HEIGHT}
                    className={active === index ? "fill-wash" : "fill-transparent"}
                  />
                  {series.map((s) => {
                    const value = Number(r[s.key] ?? 0);
                    if (value <= 0) return null;
                    const top = y(base + value);
                    const height = y(base) - top;
                    base += value;
                    return (
                      <rect
                        key={s.key}
                        x={`${index * width + width * 0.12}%`}
                        width={`${width * 0.76}%`}
                        y={top}
                        height={height}
                        fill={s.color}
                        className="stroke-card"
                        data-slot="chart-bar"
                        strokeWidth={1}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          {row ? (
            <div
              className="pointer-events-none absolute top-0 z-10 grid min-w-44 gap-1 rounded-md bg-popover px-3 py-2 text-xs text-popover-foreground shadow-elev-2"
              style={
                (active ?? 0) > data.length / 2
                  ? { right: `${100 - (active ?? 0) * width}%`, marginRight: 8 }
                  : { left: `${((active ?? 0) + 1) * width}%`, marginLeft: 8 }
              }
            >
              <span className="readout text-muted-foreground">{formatChartTime(row.time)}</span>
              {[...series].reverse().map((s) => (
                <div key={s.key} className="flex items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="max-w-48 truncate text-muted-foreground">{s.label}</span>
                  <span className="readout ml-auto pl-3 font-medium text-foreground">
                    {typeof row[s.key] === "number" ? format(row[s.key] as number) : "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="relative" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="readout absolute left-2.5 -translate-y-1/2 text-xs leading-none text-muted-foreground"
              style={{ top: y(tick) }}
            >
              {format(tick)}
            </span>
          ))}
        </div>
        <div ref={axisRef} className="relative h-6" aria-hidden="true">
          {points.map((point, index) =>
            point.axisLabel && shown.has(index) ? (
              <span
                key={point.key}
                className="readout absolute top-2 -translate-x-1/2 text-xs leading-none whitespace-nowrap text-muted-foreground"
                style={{ left: `${(index + 0.5) * width}%` }}
              >
                {point.axisLabel}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{m.chart_time()}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={point.key}>
              <th scope="row">{point.label}</th>
              {series.map((s) => (
                <td key={s.key}>
                  {typeof data[index]?.[s.key] === "number"
                    ? format(data[index][s.key] as number)
                    : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
