/**
 * Answers in the lab's empty state where a procedure's schema-derived empty value is not what an
 * empty console shows: configuration and capability singletons keep their values, records opened
 * by id keep their identity (without their own lists); a site's access control starts from the
 * defaults (access-control.ts). Everything else answers emptyOutput():
 * lists without items, zero counts, a console without sites, clusters or traffic.
 */
import { emptyAccessControlFixtures } from "./access-control";
import type { Fixtures } from "./define";
import { mergeFixtures } from "./define";
import { fixtures } from "./index";

/** Procedures (or whole namespaces, `name.*`) that answer their full fixture when empty. */
const KEEP = [
  // Configuration: settings exist on an empty console too.
  "settings.*",
  "certificates.settings",
  "logs.settings",
  "alerts.policy",
  "alerts.smtp",
  "dns.protection",
  "dns.catalog",
  "upgrades.latestVersion",
  // What the nodes and the site can do.
  "sites.features",
  // A site's own configuration, read by its tabs.
  "https.get",
  "protection.get",
  "waf.get",
  "errorPages.get",
  "maintenance.get",
  "authRules.get",
  "imageConvert.get",
  // Records opened by id.
  "clusters.get",
  "nodes.get",
  "l4Apps.get",
];

type Tree = Record<string, unknown>;

function picked(paths: readonly string[]): Fixtures {
  const out: Tree = {};
  for (const path of paths) {
    const keys = path.split(".");
    const whole = keys.at(-1) === "*";
    if (whole) keys.pop();
    let from: unknown = fixtures;
    let into = out;
    for (const [index, key] of keys.entries()) {
      from = (from as Tree | undefined)?.[key];
      if (from === undefined) break;
      if (index === keys.length - 1) {
        into[key] = whole ? { ...(from as Tree) } : from;
      } else {
        into[key] ??= {};
        into = into[key] as Tree;
      }
    }
  }
  return out as Fixtures;
}

export const emptyFixtures: Fixtures = mergeFixtures(picked(KEEP), emptyAccessControlFixtures, {
  sites: {
    // The site keeps its name and domains; its origins and cache rules are gone.
    get: async (input) => {
      const site = await fixtures.sites?.get?.(input);
      if (!site) throw new Error("sites.get has no fixture");
      return { ...site, origins: [], cacheRules: [] };
    },
  },
});
