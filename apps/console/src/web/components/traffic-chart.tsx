import type { TrafficPoint } from "@edgeweir/contract";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import { EmptyState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { getLocale, m } from "@/lib/i18n";

/** Requests and cache hits per minute (shadcn chart block, fed by lite analytics). */
export function TrafficChart({ data }: { data: TrafficPoint[] }) {
  const config = {
    requests: { label: m.overview_traffic_requests(), color: "var(--chart-2)" },
    cacheHits: { label: m.overview_traffic_hits(), color: "var(--primary)" },
  } satisfies ChartConfig;
  const time = new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit" });
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{m.overview_traffic_title()}</CardTitle>
        <CardDescription>{m.overview_traffic_description()}</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-2 sm:px-6">
        {data.length === 0 ? (
          <EmptyState title={m.overview_traffic_empty()} />
        ) : (
          <ChartContainer config={config} className="aspect-auto h-[240px] w-full">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="fillRequests" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-requests)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-requests)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillHits" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-cacheHits)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-cacheHits)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="minute"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value: string) => time.format(new Date(value))}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => time.format(new Date(String(value)))}
                    indicator="dot"
                  />
                }
              />
              <Area
                dataKey="requests"
                type="monotone"
                fill="url(#fillRequests)"
                stroke="var(--color-requests)"
              />
              <Area
                dataKey="cacheHits"
                type="monotone"
                fill="url(#fillHits)"
                stroke="var(--color-cacheHits)"
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
