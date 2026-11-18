import { type AnalyticsRange, analyticsRange, BLOCK_REASONS, type Site } from "@edgeweir/contract";
import { createContext } from "react";
import * as z from "zod";

// Keep one context instance for the layout and the independently loaded child views.
export const siteWorkspaceSearch = z.object({
  returnTo: z.string().optional(),
  range: analyticsRange.optional(),
  // A jump into the logs tab: the filters and the time window of the search.
  blockReason: z.enum([...BLOCK_REASONS, "any"]).optional(),
  ip: z.string().max(64).optional(),
  cidr: z.string().max(64).optional(),
  path: z.string().max(2048).optional(),
  crawler: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

type SiteSearch = z.infer<typeof siteWorkspaceSearch>;
export const SiteWorkspaceContext = createContext<{
  site: Site;
  search: SiteSearch;
  setRange: (range: AnalyticsRange) => void;
  analyticsHref: string;
} | null>(null);
