import type { AnalyticsRange } from "@edgeweir/contract";
import { AiCrawlOverviewSection } from "@/components/site/ai-crawl-overview";
import { AiCrawlSettingsCard } from "@/components/site/ai-crawl-settings";

/** The site's AI crawlers: their traffic over the range, then what the edge does with them. */
export function AiCrawlTab({
  siteId,
  range,
  onRangeChange,
}: {
  siteId: string;
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AiCrawlOverviewSection siteId={siteId} range={range} onRangeChange={onRangeChange} />
      <AiCrawlSettingsCard siteId={siteId} />
    </div>
  );
}
