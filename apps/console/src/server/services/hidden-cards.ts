import { type HiddenCards, OVERVIEW_CARDS, SITE_CARDS } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";

/** The stored ids that are cards today (a later version may drop one), in display order. */
const known = <T extends string>(cards: readonly T[], stored: readonly string[]): T[] =>
  cards.filter((card) => stored.includes(card));

/** The cards the user hid; none until they hide one. */
export async function getHiddenCards(db: Database, userId: string): Promise<HiddenCards> {
  const [row] = await db
    .select()
    .from(schema.hiddenCards)
    .where(eq(schema.hiddenCards.userId, userId));
  return {
    overview: known(OVERVIEW_CARDS, row?.overview ?? []),
    site: known(SITE_CARDS, row?.site ?? []),
  };
}

/** Replaces the hidden cards of the pages named (a personal preference, not audited). */
export async function updateHiddenCards(
  db: Database,
  userId: string,
  input: Partial<HiddenCards>,
): Promise<HiddenCards> {
  await db
    .insert(schema.hiddenCards)
    .values({ userId, overview: input.overview ?? [], site: input.site ?? [] })
    .onConflictDoUpdate({
      target: schema.hiddenCards.userId,
      set: {
        ...(input.overview ? { overview: input.overview } : {}),
        ...(input.site ? { site: input.site } : {}),
        updatedAt: new Date(),
      },
    });
  return getHiddenCards(db, userId);
}
