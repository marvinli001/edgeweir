import {
  type AnalyticsRange,
  BOT_SCORE_AUTOMATED_BELOW,
  BOT_SCORE_BANDS,
} from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { QueryView } from "@/components/states";
import { formatNumber, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** The highest score of a band ("1" is 1-9, "90" is 90-99). */
const bandEnd = (band: string) => (band === "1" ? 9 : Number(band) + 9);

/**
 * The distribution of the site's bot scores over the range (session detection): requests per band
 * of ten, the automated bands (below 30) in the warning color, and the automated share.
 */
export function BotScoresCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const dimensions = useQuery({
    ...orpc.analytics.dimensions.queryOptions({ input: { range, siteId } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Panel
      className="animate-enter"
      style={{ animationDelay: "345ms" }}
      data-testid="bot-scores-card"
    >
      <PanelHeader>
        <PanelTitle>{m.bot_scores_title()}</PanelTitle>
      </PanelHeader>
      <PanelContent className="flex flex-col gap-4">
        <QueryView query={dimensions}>
          {({ botScores, unsupportedNodes }) => {
            const counts = new Map(botScores.map((b) => [b.key, b.requests]));
            const total = botScores.reduce((sum, b) => sum + b.requests, 0);
            if (total === 0)
              return (
                <p className="text-sm text-muted-foreground" data-testid="bot-scores-empty">
                  {m.security_top_empty()}
                </p>
              );
            const automated = BOT_SCORE_BANDS.filter(
              (band) => Number(band) < BOT_SCORE_AUTOMATED_BELOW,
            ).reduce((sum, band) => sum + (counts.get(band) ?? 0), 0);
            const peak = Math.max(...BOT_SCORE_BANDS.map((band) => counts.get(band) ?? 0));
            return (
              <>
                <dl className="grid grid-cols-2 gap-4 sm:max-w-md">
                  <div className="flex min-w-0 flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">{m.bot_scores_automated()}</dt>
                    <dd
                      className="font-heading text-3xl font-medium tabular-nums"
                      data-testid="bot-scores-automated"
                    >
                      {formatPercent((automated / total) * 100)}
                    </dd>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">{m.bot_scores_scored()}</dt>
                    <dd
                      className="font-heading text-xl font-medium tabular-nums"
                      data-testid="bot-scores-total"
                    >
                      {formatNumber(total)}
                    </dd>
                  </div>
                </dl>
                <figure className="flex flex-col gap-1.5">
                  <ol
                    className="grid h-28 grid-cols-10 items-end gap-1"
                    aria-label={m.bot_scores_title()}
                    data-testid="bot-scores-bars"
                  >
                    {BOT_SCORE_BANDS.map((band) => {
                      const n = counts.get(band) ?? 0;
                      const label = m.bot_scores_band({
                        from: band,
                        to: String(bandEnd(band)),
                        requests: formatNumber(n),
                      });
                      return (
                        <li
                          key={band}
                          className="flex h-full items-end"
                          title={label}
                          aria-label={label}
                        >
                          <span
                            className={cn(
                              "block w-full rounded-t-[2px]",
                              Number(band) < BOT_SCORE_AUTOMATED_BELOW
                                ? "bg-warning"
                                : "bg-primary",
                              n === 0 && "opacity-0",
                            )}
                            style={{ height: `${peak ? Math.max(2, (n / peak) * 100) : 0}%` }}
                          />
                        </li>
                      );
                    })}
                  </ol>
                  <div
                    className="grid grid-cols-10 gap-1 text-[11px] text-muted-foreground tabular-nums"
                    aria-hidden="true"
                  >
                    {BOT_SCORE_BANDS.map((band) => (
                      <span key={band} className="text-center">
                        {band}
                      </span>
                    ))}
                  </div>
                </figure>
                {unsupportedNodes > 0 ? <SafetyNote>{m.stats_dims_partial()}</SafetyNote> : null}
              </>
            );
          }}
        </QueryView>
      </PanelContent>
    </Panel>
  );
}
