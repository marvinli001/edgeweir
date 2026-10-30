import type { RuleDto, Site } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import { RulesEditor } from "@/components/site/rules/editor";
import { ContentLock, LocksContext, type SiteFeatures } from "@/components/site/rules/labels";
import { RulesBodyLimitCard } from "@/components/site/rules-body-limit-card";
import { QueryView } from "@/components/states";
import { orpc } from "@/lib/orpc";

/**
 * Rules of a site (siteId) or of the platform. A site's rules can send requests to its origin
 * groups; the rule engine extensions (rules-v2), additions (rules-v3), the WAF actions (waf-v2),
 * the request body fields (rules-body-v1), the crawler fields (challenge-v2) and the managed
 * challenge (challenge-v3) stay locked while
 * the cluster's nodes lack them. With `site`, the tab also sets how much body the rules read.
 */
export function RulesTab({
  siteId,
  originGroups,
  site,
}: {
  siteId?: string;
  originGroups?: string[];
  site?: Site;
}) {
  const query = useQuery(
    siteId
      ? orpc.rules.get.queryOptions({ input: { id: siteId } })
      : orpc.platformRules.get.queryOptions(),
  );
  const features = useQuery({
    ...orpc.sites.features.queryOptions({ input: { id: siteId ?? "" } }),
    enabled: !!siteId,
  });
  const editor = (rules: RuleDto[], available?: SiteFeatures) => (
    <ContentLock.Provider value={available?.siteContent.available === false}>
      <LocksContext.Provider
        value={{
          wafV2: available?.wafV2.available === false,
          body: available?.rulesBody.available === false,
          bot: available?.challengeV2.available === false,
          managed: available?.challengeV3.available === false,
          platform: !siteId,
        }}
      >
        <RulesEditor
          key={JSON.stringify(rules)}
          initial={rules}
          siteId={siteId}
          originGroups={siteId ? (originGroups ?? []) : undefined}
          features={available}
          locked={available?.rulesV2.available === false}
          lockedV3={available?.rulesV3.available === false}
        />
      </LocksContext.Provider>
    </ContentLock.Provider>
  );
  // Platform rules have no site features to wait for.
  return (
    <div className="flex flex-col gap-5">
      <QueryView query={query}>
        {(rules) =>
          siteId ? (
            <QueryView query={features}>{(available) => editor(rules, available)}</QueryView>
          ) : (
            editor(rules)
          )
        }
      </QueryView>
      {site ? <RulesBodyLimitCard site={site} /> : null}
    </div>
  );
}
