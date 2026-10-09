import { FormSelect } from "@/components/form-select";
import { ListText, TextField } from "@/components/site/access-control/fields";
import { AccessPartCard } from "@/components/site/access-control/part-card";
import { SwitchField } from "@/components/site/fields";
import { m } from "@/lib/i18n";

/**
 * Hotlink protection: requests for the covered files whose Referer (and Origin, when checked)
 * names another site get 403 or a redirect. The extensions start as the common media and
 * download types; off, only the switch shows.
 */
export function HotlinkCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="hotlink"
      title={m.access_hotlink_title()}
      testId="hotlink"
      index={index}
      toDraft={(value) => value}
      toPart={(draft) => draft}
      inUse={(value) => value.enabled}
      labels={{
        allowed: m.access_hotlink_allowed,
        denied: m.access_hotlink_denied,
        extensions: m.access_extensions,
        pathPrefixes: m.access_path_prefixes,
        excludePathPrefixes: m.access_exclude_prefixes,
        redirectUrl: m.access_hotlink_redirect_url,
      }}
    >
      {({ draft, set, blocked, invalid }) => (
        <>
          <SwitchField
            id="hotlink-enabled"
            label={m.access_enabled()}
            checked={draft.enabled}
            disabled={blocked}
            onCheckedChange={(enabled) => set({ enabled })}
            className="self-start"
            testId="hotlink-enabled"
          />
          {draft.enabled ? (
            <div className="flex flex-col gap-5 animate-in fade-in">
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <SwitchField
                  id="hotlink-allow-empty"
                  label={m.access_hotlink_allow_empty()}
                  checked={draft.allowEmpty}
                  onCheckedChange={(allowEmpty) => set({ allowEmpty })}
                  testId="hotlink-allow-empty"
                />
                <SwitchField
                  id="hotlink-allow-site"
                  label={m.access_hotlink_allow_site()}
                  checked={draft.allowSiteDomains}
                  onCheckedChange={(allowSiteDomains) => set({ allowSiteDomains })}
                  testId="hotlink-allow-site"
                />
                <SwitchField
                  id="hotlink-check-origin"
                  label={m.access_hotlink_check_origin()}
                  checked={draft.checkOrigin}
                  onCheckedChange={(checkOrigin) => set({ checkOrigin })}
                  testId="hotlink-check-origin"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ListText
                  id="hotlink-allowed"
                  label={m.access_hotlink_allowed()}
                  value={draft.allowed}
                  placeholder={"partner.example.com\n*.example.org"}
                  invalid={invalid("allowed")}
                  onChange={(allowed) => set({ allowed })}
                  testId="hotlink-allowed"
                />
                <ListText
                  id="hotlink-denied"
                  label={m.access_hotlink_denied()}
                  value={draft.denied}
                  placeholder=".example.net"
                  invalid={invalid("denied")}
                  onChange={(denied) => set({ denied })}
                  testId="hotlink-denied"
                />
              </div>
              <ListText
                id="hotlink-extensions"
                mode="words"
                label={m.access_extensions()}
                value={draft.extensions}
                placeholder="jpg, png, mp4"
                invalid={invalid("extensions")}
                onChange={(extensions) => set({ extensions })}
                testId="hotlink-extensions"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <ListText
                  id="hotlink-prefixes"
                  label={m.access_path_prefixes()}
                  value={draft.pathPrefixes}
                  placeholder="/images/"
                  invalid={invalid("pathPrefixes")}
                  onChange={(pathPrefixes) => set({ pathPrefixes })}
                  testId="hotlink-prefixes"
                />
                <ListText
                  id="hotlink-excludes"
                  label={m.access_exclude_prefixes()}
                  value={draft.excludePathPrefixes}
                  placeholder="/images/public/"
                  invalid={invalid("excludePathPrefixes")}
                  onChange={(excludePathPrefixes) => set({ excludePathPrefixes })}
                  testId="hotlink-excludes"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <FormSelect
                  id="hotlink-action"
                  label={m.access_hotlink_action()}
                  value={draft.action}
                  options={[
                    { value: "deny", label: m.access_hotlink_action_deny() },
                    { value: "redirect", label: m.access_hotlink_action_redirect() },
                  ]}
                  onChange={(action) => set({ action })}
                  testId="hotlink-action"
                />
                {draft.action === "redirect" ? (
                  <TextField
                    id="hotlink-redirect"
                    label={m.access_hotlink_redirect_url()}
                    value={draft.redirectUrl}
                    placeholder="/images/hotlink.png"
                    maxLength={2048}
                    invalid={invalid("redirectUrl")}
                    onChange={(redirectUrl) => set({ redirectUrl })}
                    testId="hotlink-redirect"
                  />
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </AccessPartCard>
  );
}
