import {
  FRAME_OPTIONS,
  PERMISSIONS_POLICY_MAX,
  REFERRER_POLICIES,
  type SecurityHeaderSettings,
} from "@edgeweir/contract";
import { FormSelect } from "@/components/form-select";
import { TextField } from "@/components/site/access-control/fields";
import { AccessPartCard } from "@/components/site/access-control/part-card";
import { SwitchField } from "@/components/site/fields";
import { m } from "@/lib/i18n";

const used = (value: SecurityHeaderSettings) =>
  value.nosniff ||
  value.frameOptions !== "off" ||
  value.referrerPolicy !== "off" ||
  value.permissionsPolicy !== "" ||
  value.hideServer ||
  value.removePoweredBy;

/** "off" is "not set"; the other values are the header's own. */
const options = <T extends string>(values: readonly T[]) =>
  values.map((value) => ({ value, label: value === "off" ? m.access_headers_off() : value }));

/**
 * Security response headers on every response of the site, cache hits and the node's own pages
 * included. Response header rules run after them, so a rule can still change or drop one.
 */
export function SecurityHeadersCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="securityHeaders"
      title={m.access_headers_title()}
      testId="headers"
      index={index}
      toDraft={(value) => value}
      toPart={(draft) => draft}
      inUse={used}
      labels={{ permissionsPolicy: m.access_headers_permissions }}
    >
      {({ draft, set, blocked, invalid }) => (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <SwitchField
              id="headers-nosniff"
              label={m.access_headers_nosniff()}
              checked={draft.nosniff}
              disabled={blocked}
              onCheckedChange={(nosniff) => set({ nosniff })}
              testId="headers-nosniff"
            />
            <SwitchField
              id="headers-hide-server"
              label={m.access_headers_hide_server()}
              checked={draft.hideServer}
              disabled={blocked}
              onCheckedChange={(hideServer) => set({ hideServer })}
              testId="headers-hide-server"
            />
            <SwitchField
              id="headers-powered-by"
              label={m.access_headers_remove_powered_by()}
              checked={draft.removePoweredBy}
              disabled={blocked}
              onCheckedChange={(removePoweredBy) => set({ removePoweredBy })}
              testId="headers-powered-by"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormSelect
              id="headers-frame"
              label={m.access_headers_frame()}
              value={draft.frameOptions}
              options={options(FRAME_OPTIONS)}
              disabled={blocked}
              onChange={(frameOptions) => set({ frameOptions })}
              testId="headers-frame"
            />
            <FormSelect
              id="headers-referrer"
              label={m.access_headers_referrer()}
              value={draft.referrerPolicy}
              options={options(REFERRER_POLICIES)}
              disabled={blocked}
              onChange={(referrerPolicy) => set({ referrerPolicy })}
              testId="headers-referrer"
            />
          </div>
          <TextField
            id="headers-permissions"
            label={m.access_headers_permissions()}
            value={draft.permissionsPolicy}
            placeholder="camera=(), geolocation=(), microphone=()"
            maxLength={PERMISSIONS_POLICY_MAX}
            disabled={blocked}
            invalid={invalid("permissionsPolicy")}
            onChange={(permissionsPolicy) => set({ permissionsPolicy })}
            testId="headers-permissions"
          />
        </>
      )}
    </AccessPartCard>
  );
}
