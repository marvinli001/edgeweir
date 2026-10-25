import { DashboardSquareEditIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CardId, CardScope, HiddenCardsState } from "@/hooks/use-hidden-cards";
import { m } from "@/lib/i18n";

export interface CardGroup<S extends CardScope> {
  /** Shown above the group when the menu has more than one. */
  label: string;
  cards: { id: CardId<S>; label: string }[];
}

/**
 * Which cards a page shows: one check per card, grouped by section, and a reset that shows them
 * all. The menu stays open while cards are switched.
 */
export function CardsMenu<S extends CardScope>({
  groups,
  cards,
}: {
  groups: CardGroup<S>[];
  cards: HiddenCardsState<S>;
}) {
  const labelled = groups.length > 1;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="icon-button"
            size="sm"
            variant="ghost"
            aria-label={m.cards_customize()}
            title={m.cards_customize()}
            disabled={!cards.query.isSuccess}
            data-testid="cards-menu"
          />
        }
      >
        <HugeiconsIcon icon={DashboardSquareEditIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {groups.map((group, index) => (
          <React.Fragment key={group.label}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              {labelled ? <DropdownMenuLabel>{group.label}</DropdownMenuLabel> : null}
              {group.cards.map((card) => (
                <DropdownMenuCheckboxItem
                  key={card.id}
                  checked={!cards.hidden.has(card.id)}
                  closeOnClick={false}
                  onCheckedChange={() => cards.toggle(card.id)}
                  data-testid={`card-toggle-${card.id}`}
                >
                  {card.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </React.Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={cards.hidden.size === 0}
          onClick={cards.reset}
          data-testid="cards-reset"
        >
          {m.cards_reset()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
