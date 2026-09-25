import type * as React from "react";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export interface StatCard {
  label: string;
  value: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
}

export function SectionCards({ cards }: { cards: StatCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {cards.map((card) => (
        <Card key={card.label} className="@container/card" data-testid={card.testId}>
          <CardHeader>
            <CardDescription>{card.label}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {card.value}
            </CardTitle>
          </CardHeader>
          {card.footer ? (
            <CardFooter className="text-sm text-muted-foreground">{card.footer}</CardFooter>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
