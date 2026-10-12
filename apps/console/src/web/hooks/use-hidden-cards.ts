import type { HiddenCards } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { errorMessage, orpc } from "@/lib/orpc";

export type CardScope = keyof HiddenCards;
export type CardId<S extends CardScope> = HiddenCards[S][number];

/**
 * The cards the user hid on a page (the console home or a site's statistics), kept with their
 * account. A change shows at once; saves run one after another, each with the whole list, so the
 * last one wins. A failed save says so and reloads what was saved.
 */
export function useHiddenCards<S extends CardScope>(scope: S) {
  const queryClient = useQueryClient();
  const queryKey = orpc.hiddenCards.get.queryKey();
  const query = useQuery(orpc.hiddenCards.get.queryOptions());
  const { mutate } = useMutation({
    ...orpc.hiddenCards.update.mutationOptions(),
    scope: { id: "hidden-cards" },
    onError: (error) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const list = query.data?.[scope] as CardId<S>[] | undefined;
  const hidden = React.useMemo(() => new Set<CardId<S>>(list), [list]);

  /** Applies a change to the latest list (not this render's), shows it and saves it. */
  const save = (change: (hidden: Set<CardId<S>>) => void) => {
    const current = queryClient.getQueryData(queryKey);
    if (!current) return;
    const next = new Set(current[scope] as CardId<S>[]);
    change(next);
    const cards = [...next];
    // A load in flight would bring back the list from before.
    void queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, { ...current, [scope]: cards });
    mutate({ [scope]: cards });
  };

  return {
    query,
    hidden,
    /** Shows or hides one card. */
    toggle: (id: CardId<S>) =>
      save((next) => {
        if (!next.delete(id)) next.add(id);
      }),
    /** Shows the cards given. */
    show: (ids: readonly CardId<S>[]) =>
      save((next) => {
        for (const id of ids) next.delete(id);
      }),
    /** Shows every card of the page. */
    reset: () => save((next) => next.clear()),
  };
}

export type HiddenCardsState<S extends CardScope> = ReturnType<typeof useHiddenCards<S>>;
