import {
  AI_CRAWL_ACTIONS,
  AI_CRAWL_TOKEN_ACTIONS,
  type AiCrawlAction,
  type AiCrawlCatalogue,
} from "@edgeweir/contract";
import type * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { OptionSelect } from "@/components/form-select";
import {
  aiCrawlActionLabel,
  aiCrawlerCategoryLabel,
  resolvedActionLabel,
  verifiedByLabel,
} from "@/lib/ai-crawl";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const INHERIT = "inherit";
type Choice = AiCrawlAction | typeof INHERIT;

interface AiCrawlActions {
  crawlers: Record<string, AiCrawlAction>;
  operators: Record<string, AiCrawlAction>;
}

/** `record` with `id` set to `action`, or without it for the inherited one. */
function withChoice(record: Record<string, AiCrawlAction>, id: string, choice: Choice) {
  const { [id]: _old, ...rest } = record;
  return choice === INHERIT ? rest : { ...rest, [id]: choice };
}

/**
 * The actions per operator and crawler of the catalogue: each operator row, then its crawlers.
 * A row without an action of its own shows what it falls back to (`inherited`). robots.txt-only
 * tokens take allow or block; charge is offered while `charge` is on (or already chosen).
 */
export function AiCrawlActionList({
  catalogue,
  value,
  onChange,
  inherited,
  charge,
  idPrefix,
}: {
  catalogue: AiCrawlCatalogue;
  value: AiCrawlActions;
  onChange: (value: AiCrawlActions) => void;
  /** What a row without its own action resolves to. */
  inherited: (row: { kind: "crawler" | "operator"; id: string }) => AiCrawlAction | null;
  charge: boolean;
  idPrefix: string;
}) {
  const options = (
    own: AiCrawlAction | undefined,
    actions: readonly AiCrawlAction[],
    from: AiCrawlAction | null,
  ) => [
    { value: INHERIT as Choice, label: m.ai_crawl_inherit({ action: resolvedActionLabel(from) }) },
    ...actions
      .filter((a) => a !== "charge" || charge || own === "charge")
      .map((a) => ({ value: a as Choice, label: aiCrawlActionLabel(a) })),
  ];
  return (
    <ul
      className="flex flex-col divide-y rounded-lg faint-well"
      data-testid={`${idPrefix}-actions`}
    >
      {catalogue.operators.map((operator) => {
        const crawlers = catalogue.crawlers.filter((c) => c.operator === operator.id);
        if (crawlers.length === 0) return null;
        const own = value.operators[operator.id];
        return (
          <li key={operator.id} className="flex flex-col py-1">
            <Row
              name={operator.name}
              strong
              id={`${idPrefix}-operator-${operator.id}`}
              value={own ?? INHERIT}
              options={options(
                own,
                AI_CRAWL_ACTIONS,
                inherited({ kind: "operator", id: operator.id }),
              )}
              onChange={(choice) =>
                onChange({ ...value, operators: withChoice(value.operators, operator.id, choice) })
              }
            />
            {crawlers.map((crawler) => {
              const mine = value.crawlers[crawler.id];
              return (
                <Row
                  key={crawler.id}
                  name={crawler.name}
                  id={`${idPrefix}-crawler-${crawler.id}`}
                  value={mine ?? INHERIT}
                  aside={
                    <>
                      <Badge size="sm" tone="neutral">
                        {aiCrawlerCategoryLabel(crawler.category)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {verifiedByLabel(crawler)}
                      </span>
                    </>
                  }
                  options={options(
                    mine,
                    crawler.detectable ? AI_CRAWL_ACTIONS : AI_CRAWL_TOKEN_ACTIONS,
                    inherited({ kind: "crawler", id: crawler.id }),
                  )}
                  onChange={(choice) =>
                    onChange({ ...value, crawlers: withChoice(value.crawlers, crawler.id, choice) })
                  }
                />
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

function Row({
  name,
  strong,
  aside,
  id,
  value,
  options,
  onChange,
}: {
  name: string;
  strong?: boolean;
  aside?: React.ReactNode;
  id: string;
  value: Choice;
  options: { value: Choice; label: string }[];
  onChange: (choice: Choice) => void;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5", !strong && "pl-6")}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className={cn("text-sm", strong && "font-medium")}>{name}</span>
        {aside}
      </div>
      <OptionSelect
        id={id}
        size="sm"
        className="w-full sm:w-48"
        label={name}
        value={value}
        options={options}
        onChange={onChange}
        testId={id}
      />
    </div>
  );
}
