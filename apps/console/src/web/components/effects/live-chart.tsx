/*
 * A live series on canvas (uPlot, MIT, Leon Sorokin): the signal line over a fading wash, value
 * ticks on the right, a glow on the line in dark mode. Hovering reports the point to `onRead`.
 * Colors are tokens read through a canvas and re-read when the theme changes. uPlot draws only
 * when the data or size changes, so there is no loop to stop. The one exception to the effects'
 * DPR cap: uPlot always draws at the screen's own ratio (window.devicePixelRatio, no option), so
 * on 3x screens this canvas is 3x. That costs one draw per poll (10 s) or resize, never a loop;
 * the glow pass uses the same ratio (uPlot.pxRatio) so it matches the line. Lazy-loaded with the
 * page.
 */
import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { tokenRgb, useThemeKey } from "./tokens";

export interface LivePoint {
  /** Unix seconds. */
  time: number;
  value: number;
}

export default function LiveChart({
  points,
  format,
  formatTime,
  label,
  onRead,
  height = 168,
}: {
  points: LivePoint[];
  format: (value: number) => string;
  formatTime: (seconds: number) => string;
  /** What the chart shows, for screen readers (with the latest value). */
  label: string;
  /** The hovered point, or null when the pointer leaves. */
  onRead?: (point: LivePoint | null) => void;
  height?: number;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const plot = React.useRef<uPlot | null>(null);
  const theme = useThemeKey();
  const [width, setWidth] = React.useState(0);
  const read = React.useRef(onRead);
  read.current = onRead;
  const formats = React.useRef({ format, formatTime });
  formats.current = { format, formatTime };

  React.useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry?.contentRect.width ?? 0)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // (Re)build for a theme; data and size are applied in place below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme re-reads the tokens; data and width are set separately.
  React.useEffect(() => {
    const element = wrap.current;
    if (!element || width === 0) return;
    const dark = theme === "dark";
    const signal = tokenRgb("--signal");
    const glow = tokenRgb("--signal", 0.7);
    const muted = tokenRgb("--muted-foreground");
    const grid = tokenRgb("--border");
    const font = `11px ${getComputedStyle(element).fontFamily}`;
    const options: uPlot.Options = {
      width,
      height,
      pxAlign: false,
      legend: { show: false },
      padding: [8, 0, 0, 14],
      cursor: {
        x: true,
        y: false,
        points: { size: 7, fill: signal, stroke: tokenRgb("--card"), width: 2 },
        drag: { x: false, y: false },
      },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, max * 1.15 || 1] } },
      axes: [
        {
          stroke: muted,
          font,
          grid: { show: false },
          ticks: { show: false },
          size: 24,
          values: (_u, splits) => splits.map((s) => formats.current.formatTime(s)),
        },
        {
          side: 1,
          stroke: muted,
          font,
          size: 56,
          gap: 6,
          ticks: { show: false },
          grid: { stroke: grid, width: 1, dash: [2, 4] },
          values: (_u, splits) => splits.map((s) => formats.current.format(s)),
        },
      ],
      series: [
        {},
        {
          stroke: signal,
          width: 1.75,
          points: { show: false },
          fill: (u) => {
            const gradient = u.ctx.createLinearGradient(
              0,
              u.bbox.top,
              0,
              u.bbox.top + u.bbox.height,
            );
            gradient.addColorStop(0, tokenRgb("--signal", dark ? 0.3 : 0.22));
            gradient.addColorStop(1, tokenRgb("--signal", 0));
            return gradient;
          },
        },
      ],
      hooks: {
        // The glow: the line drawn again, blurred, under itself (dark mode only).
        drawSeries: dark
          ? [
              (u, index) => {
                const path = (u.series[index] as { _paths?: { stroke?: Path2D } })._paths?.stroke;
                if (!path) return;
                const ctx = u.ctx;
                ctx.save();
                ctx.shadowColor = glow;
                // uPlot's own ratio, so the glow traces the line it strokes at width × pxRatio.
                ctx.shadowBlur = 10 * uPlot.pxRatio;
                ctx.strokeStyle = signal;
                ctx.lineWidth = 1.75 * uPlot.pxRatio;
                ctx.stroke(path);
                ctx.restore();
              },
            ]
          : [],
        setCursor: [
          (u) => {
            const index = u.cursor.idx;
            const time = index == null ? undefined : u.data[0][index];
            const value = index == null ? undefined : u.data[1]?.[index];
            read.current?.(time == null || value == null ? null : { time, value: value as number });
          },
        ],
      },
    };
    const instance = new uPlot(options, [[], []], element);
    plot.current = instance;
    return () => {
      instance.destroy();
      plot.current = null;
    };
  }, [theme, height, width === 0]);

  React.useEffect(() => {
    if (width > 0) plot.current?.setSize({ width, height });
  }, [width, height]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a rebuilt plot (theme, first size) needs the data again.
  React.useEffect(() => {
    plot.current?.setData([points.map((p) => p.time), points.map((p) => p.value)]);
  }, [points, theme, width === 0]);

  const last = points.at(-1);
  return (
    <div className="relative">
      <div ref={wrap} className="live-chart w-full" style={{ height }} aria-hidden />
      <p className="sr-only">
        {label}
        {last ? `: ${format(last.value)}` : ""}
      </p>
    </div>
  );
}
