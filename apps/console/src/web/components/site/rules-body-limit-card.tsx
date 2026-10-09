import type { Site } from "@edgeweir/contract";
import { RULES_BODY_LIMIT } from "@edgeweir/rule-engine";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * The largest request body (by Content-Length, in bytes) the site's rules read: request body
 * fields, form_value and json_value see larger ones as truncated. Saved with the other content
 * settings as they are.
 */
export function RulesBodyLimitCard({ site }: { site: Site }) {
  const saved = site.contentSettings.rulesBodyLimit;
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  const [value, setValue] = React.useState(() => String(saved));
  const { save, error, pending } = useSaveSite(site.id);
  const bytes = Number(value);
  const valid =
    value.trim() !== "" &&
    Number.isInteger(bytes) &&
    bytes >= RULES_BODY_LIMIT.min &&
    bytes <= RULES_BODY_LIMIT.max;
  // Another limit than the default waits for rules-body-v1 (a saved one stays editable).
  const blocked =
    features.data?.rulesBody.available === false && saved === RULES_BODY_LIMIT.default;
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
      data-testid="rules-body-limit-card"
    >
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            void save({ contentSettings: { ...site.contentSettings, rulesBodyLimit: bytes } });
        }}
      >
        <CardHeader>
          <CardTitle>{m.rules_body_limit_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {blocked ? (
            <SafetyNote className="animate-in fade-in" data-testid="rules-body-limit-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          ) : null}
          <div className="w-full sm:w-56">
            <NumberField
              id="rules-body-limit"
              label={m.rules_body_limit_value()}
              value={value}
              min={RULES_BODY_LIMIT.min}
              max={RULES_BODY_LIMIT.max}
              step={1}
              required
              disabled={blocked}
              invalid={value.trim() !== "" && !valid}
              onChange={setValue}
              testId="rules-body-limit"
            />
          </div>
        </CardContent>
        <SaveBar
          dirty={valid && bytes !== saved}
          pending={pending}
          error={error}
          testId="rules-body-limit-save"
          errorTestId="rules-body-limit-error"
        />
      </form>
    </Card>
  );
}
