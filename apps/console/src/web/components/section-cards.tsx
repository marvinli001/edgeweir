import type * as React from "react";
import { AnimatedValue, BorderBeam } from "@/components/appica/effects";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface StatCard {
  label: string;
  value: string;
  /** Sparkline, meter or other visual shown under the value. */
  visual?: React.ReactNode;
  footer?: React.ReactNode;
  /** Run a border beam around the card, colored by state. */
  beam?: "primary" | "success" | "destructive";
  testId?: string;
}

/** Stat cards that enter one after another. */
export function SectionCards({ cards }: { cards: StatCard[] }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 @xl/main:grid-cols-2",
        cards.length >= 4 ? "@5xl/main:grid-cols-4" : "@5xl/main:grid-cols-3",
      )}
    >
      {cards.map((card, index) => {
        const body = (
          <Card
            className="@container/card h-full bg-linear-to-t from-primary/5 to-card shadow-xs dark:bg-card dark:from-primary/10"
            data-testid={card.testId}
          >
            <CardHeader>
              <CardDescription>{card.label}</CardDescription>
              <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                <AnimatedValue value={card.value} />
              </CardTitle>
            </CardHeader>
            {card.visual || card.footer ? (
              <CardFooter className="mt-auto flex-col items-stretch gap-2 text-sm text-muted-foreground">
                {card.visual}
                {card.footer}
              </CardFooter>
            ) : null}
          </Card>
        );
        return (
          <div
            key={card.label}
            className="animate-enter"
            style={{ animationDelay: `${index * 70}ms` }}
          >
            {card.beam ? (
              <BorderBeam tone={card.beam} className="h-full">
                {body}
              </BorderBeam>
            ) : (
              body
            )}
          </div>
        );
      })}
    </div>
  );
}
