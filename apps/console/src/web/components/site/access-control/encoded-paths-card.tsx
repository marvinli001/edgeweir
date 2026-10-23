import type { EncodedPathSettings } from "@edgeweir/contract";
import { ENCODED_PATH_MAX_EXEMPTIONS } from "@edgeweir/rule-engine";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SafetyNote } from "@/components/safety-note";
import { AccessPartCard, type PartFields } from "@/components/site/access-control/part-card";
import { SwitchField } from "@/components/site/fields";
import { nextDraftKey } from "@/components/site/save-site";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";

type Exemption = EncodedPathSettings["exemptions"][number];
interface Row extends Exemption {
  key: number;
}
interface Draft {
  exemptions: Row[];
}

/**
 * Raw path prefixes whose requests may carry an encoded slash and / or ";" path parameters as
 * they are (Site.encoded_path_exemptions): such paths are compared in every way the origin may
 * read them and cached, instead of falling into every access check uncached.
 */
export function EncodedPathsCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="encodedPaths"
      feature="encodedPaths"
      title={m.access_encoded_title()}
      testId="encoded-paths"
      index={index}
      toDraft={(value): Draft => ({
        exemptions: value.exemptions.map((e) => ({ ...e, key: nextDraftKey() })),
      })}
      toPart={(draft) => ({
        exemptions: draft.exemptions.map(({ prefix, encodedSlash, semicolon }) => ({
          prefix,
          encodedSlash,
          semicolon,
        })),
      })}
      inUse={(value) => value.exemptions.length > 0}
      labels={{
        exemptions: m.access_encoded_title,
        prefix: m.access_encoded_prefix,
        encodedSlash: m.access_encoded_slash,
      }}
    >
      {(fields) => <EncodedPathFields {...fields} />}
    </AccessPartCard>
  );
}

function EncodedPathFields({ draft, set, blocked, invalid }: PartFields<Draft>) {
  const rows = draft.exemptions;
  const setRows = (exemptions: Row[]) => set({ exemptions });
  const change = (index: number, patch: Partial<Exemption>) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const add = () =>
    setRows([...rows, { key: nextDraftKey(), prefix: "", encodedSlash: true, semicolon: false }]);
  if (rows.length === 0)
    return (
      <EmptyState title={m.access_encoded_empty()}>
        <Button
          type="button"
          disabled={blocked}
          onClick={add}
          data-testid="encoded-paths-add-empty"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.access_encoded_add()}
        </Button>
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <SafetyNote>{m.access_encoded_note()}</SafetyNote>
      <ul className="-mx-(--card-spacing) flex flex-col border-y" data-testid="encoded-paths-rows">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-(--card-spacing) py-3 first:border-t-0 animate-enter"
            style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
            data-testid="encoded-paths-row"
          >
            <Input
              value={row.prefix}
              aria-label={m.access_encoded_prefix()}
              placeholder="/assets/"
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid("exemptions", index) || undefined}
              onChange={(event) => change(index, { prefix: event.target.value })}
              className="h-8 min-w-0 flex-1 basis-0 font-mono text-sm"
              data-testid="encoded-paths-prefix"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="sm:order-last"
              aria-label={m.common_delete()}
              onClick={() => setRows(rows.filter((_, i) => i !== index))}
              data-testid="encoded-paths-delete"
            >
              <HugeiconsIcon icon={Delete02Icon} />
            </Button>
            <div className="flex basis-full items-center gap-4 sm:basis-auto">
              <SwitchField
                id={`encoded-paths-slash-${row.key}`}
                label={m.access_encoded_slash()}
                checked={row.encodedSlash}
                onCheckedChange={(encodedSlash) => change(index, { encodedSlash })}
                className="self-center"
                testId="encoded-paths-slash"
              />
              <SwitchField
                id={`encoded-paths-semicolon-${row.key}`}
                label={m.access_encoded_semicolon()}
                checked={row.semicolon}
                onCheckedChange={(semicolon) => change(index, { semicolon })}
                className="self-center"
                testId="encoded-paths-semicolon"
              />
            </div>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={rows.length >= ENCODED_PATH_MAX_EXEMPTIONS}
        onClick={add}
        data-testid="encoded-paths-add"
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        {m.access_encoded_add()}
      </Button>
    </div>
  );
}
