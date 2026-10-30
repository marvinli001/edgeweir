import type { AiCrawlModel } from "./models";

/** Whether AI crawl control does anything for the site (else it compiles as before). */
export function aiCrawlActive(m: AiCrawlModel): boolean {
  return (
    Object.keys(m.actions).length > 0 ||
    m.impersonators !== "none" ||
    m.robotsTxt !== "" ||
    m.priceMicros > 0
  );
}

/** Whether the site's AI crawl control can challenge (it then needs challenge keys). */
export function aiCrawlChallenges(m: AiCrawlModel | undefined): boolean {
  return (
    !!m &&
    (m.impersonators === "challenge" || Object.values(m.actions).some((a) => a === "challenge"))
  );
}
