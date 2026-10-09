import type { GeoSettings } from "@edgeweir/contract";
import { FormSelect } from "@/components/form-select";
import { ListText } from "@/components/site/access-control/fields";
import { AccessPartCard } from "@/components/site/access-control/part-card";
import { ListInput, SwitchField } from "@/components/site/fields";
import { Field, FieldLabel } from "@/components/ui/field";
import { m } from "@/lib/i18n";

type Draft = Omit<GeoSettings, "asns"> & { asns: string[] };

/**
 * Geo access: only the listed countries, subdivisions and ASNs pass (allow), or they get 403
 * (deny), on the paths it covers. The settings stay while it is off; off, only the switch shows.
 */
export function GeoCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="geo"
      title={m.access_geo_title()}
      testId="geo"
      index={index}
      toDraft={(value): Draft => ({ ...value, asns: value.asns.map(String) })}
      // Not a number ("AS13335" too) stays a string, so the contract names the item.
      toPart={(draft) => ({
        ...draft,
        asns: draft.asns.map((asn) => (/^\d+$/.test(asn) ? Number(asn) : asn)),
      })}
      inUse={(value) => value.enabled}
      labels={{
        countries: m.access_geo_countries,
        subdivisions: m.access_geo_subdivisions,
        asns: m.access_geo_asns,
        pathPrefixes: m.access_path_prefixes,
        exceptPathPrefixes: m.access_exclude_prefixes,
      }}
    >
      {({ draft, set, blocked, invalid }) => (
        <>
          <SwitchField
            id="geo-enabled"
            label={m.access_enabled()}
            checked={draft.enabled}
            disabled={blocked}
            onCheckedChange={(enabled) => set({ enabled })}
            className="self-start"
            testId="geo-enabled"
          />
          {draft.enabled ? (
            <div className="flex flex-col gap-5 animate-in fade-in">
              <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <FormSelect
                  id="geo-mode"
                  label={m.access_geo_mode()}
                  value={draft.mode}
                  options={[
                    { value: "deny", label: m.access_geo_mode_deny() },
                    { value: "allow", label: m.access_geo_mode_allow() },
                  ]}
                  onChange={(mode) => set({ mode })}
                  testId="geo-mode"
                />
                <Field data-invalid={invalid("countries") || undefined}>
                  <FieldLabel htmlFor="geo-countries">{m.access_geo_countries()}</FieldLabel>
                  <ListInput
                    id="geo-countries"
                    value={draft.countries}
                    placeholder="CN, US"
                    invalid={invalid("countries")}
                    onChange={(countries) => set({ countries })}
                    testId="geo-countries"
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={invalid("subdivisions") || undefined}>
                  <FieldLabel htmlFor="geo-subdivisions">{m.access_geo_subdivisions()}</FieldLabel>
                  <ListInput
                    id="geo-subdivisions"
                    value={draft.subdivisions}
                    placeholder="US-CA, CN-GD"
                    invalid={invalid("subdivisions")}
                    onChange={(subdivisions) => set({ subdivisions })}
                    testId="geo-subdivisions"
                  />
                </Field>
                <Field data-invalid={invalid("asns") || undefined}>
                  <FieldLabel htmlFor="geo-asns">{m.access_geo_asns()}</FieldLabel>
                  <ListInput
                    id="geo-asns"
                    value={draft.asns}
                    placeholder="64496, 64511"
                    invalid={invalid("asns")}
                    onChange={(asns) => set({ asns })}
                    testId="geo-asns"
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ListText
                  id="geo-prefixes"
                  label={m.access_path_prefixes()}
                  value={draft.pathPrefixes}
                  placeholder="/downloads/"
                  invalid={invalid("pathPrefixes")}
                  onChange={(pathPrefixes) => set({ pathPrefixes })}
                  testId="geo-prefixes"
                />
                <ListText
                  id="geo-except"
                  label={m.access_exclude_prefixes()}
                  value={draft.exceptPathPrefixes}
                  placeholder="/healthz"
                  invalid={invalid("exceptPathPrefixes")}
                  onChange={(exceptPathPrefixes) => set({ exceptPathPrefixes })}
                  testId="geo-except"
                />
              </div>
            </div>
          ) : null}
        </>
      )}
    </AccessPartCard>
  );
}
