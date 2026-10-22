import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * Cards of the console home, in the order it shows them: the live tiles, the statistics and the
 * lists under them.
 */
export const OVERVIEW_CARDS = [
  "live-requests",
  "live-egress",
  "live-hit-ratio",
  "live-nodes",
  "requests",
  "data-transfer",
  "edge-network",
  "hit-ratio",
  "peak-bandwidth",
  "4xx-rate",
  "5xx-rate",
  "status-codes",
  "top-sites",
  "top-nodes",
  "top-countries",
  "top-urls",
  "top-ips",
  "revisions",
  "recents",
  "sites",
  "nodes",
] as const;

/** Cards of a site's statistics, in the order it shows them. */
export const SITE_CARDS = [
  "requests",
  "data-transfer",
  "hit-ratio",
  "peak-bandwidth",
  "4xx-rate",
  "5xx-rate",
  "status-codes",
  "top-urls",
  "top-ips",
  "countries",
  "asns",
  "referers",
  "clients",
  "protocols",
] as const;

const overviewCard = z.enum(OVERVIEW_CARDS);
const siteCard = z.enum(SITE_CARDS);

/** Cards as written: repeats dropped. */
const cardList = <T extends z.ZodEnum>(card: T) =>
  z
    .array(card)
    .max(card.options.length)
    .transform((cards) => [...new Set(cards)]);

/**
 * The cards the user hid on the console home and on every site's statistics. Every other card
 * shows, also a card a later version adds.
 */
const hiddenCards = z.object({
  overview: z.array(overviewCard),
  site: z.array(siteCard),
});

/** Replaces the hidden cards of the pages it names. */
const hiddenCardsInput = z
  .object({ overview: cardList(overviewCard).optional(), site: cardList(siteCard).optional() })
  .refine((input) => input.overview !== undefined || input.site !== undefined, {
    message: "nothing to change",
    path: ["overview"],
  });

/** The caller's own choice: a personal preference, not audited. */
export const hiddenCardsContract = {
  get: oc.route({ method: "GET", path: "/hidden-cards", tags: ["account"] }).output(hiddenCards),
  update: oc
    .route({ method: "PATCH", path: "/hidden-cards", tags: ["account"] })
    .input(hiddenCardsInput)
    .output(hiddenCards),
};

export type OverviewCard = z.infer<typeof overviewCard>;
export type SiteCard = z.infer<typeof siteCard>;
export type HiddenCards = z.infer<typeof hiddenCards>;
