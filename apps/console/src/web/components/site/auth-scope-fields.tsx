import { displaySiteDomain } from "@edgeweir/contract";
import { Input } from "@/components/arc/input/input";
import { Textarea } from "@/components/arc/textarea/textarea";
import { Field, FieldLabel } from "@/components/layout/form";
import { CheckboxList } from "@/components/site/ports-card";
import { m } from "@/lib/i18n";

export interface AuthScopeDraft {
  domains: string[];
  pathPrefixes: string;
  excludePathPrefixes: string;
  extensions: string;
}

export function AuthScopeFields({
  domains,
  value,
  onChange,
  idPrefix = "auth",
}: {
  domains: string[];
  value: AuthScopeDraft;
  onChange: (change: Partial<AuthScopeDraft>) => void;
  idPrefix?: string;
}) {
  return (
    <>
      {domains.length > 1 ? (
        <CheckboxList
          id={`${idPrefix}-domains`}
          legend={m.auth_domains()}
          options={domains.map((domain) => ({ value: domain, label: displaySiteDomain(domain) }))}
          value={value.domains}
          onChange={(next) => onChange({ domains: next })}
          testId={`${idPrefix}-domains`}
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-prefixes`}>{m.auth_path_prefixes()}</FieldLabel>
          <Textarea
            id={`${idPrefix}-prefixes`}
            rows={2}
            value={value.pathPrefixes}
            placeholder="/admin/"
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(event) => onChange({ pathPrefixes: event.target.value })}
            data-testid={`${idPrefix}-prefixes`}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-excludes`}>{m.auth_exclude_prefixes()}</FieldLabel>
          <Textarea
            id={`${idPrefix}-excludes`}
            rows={2}
            value={value.excludePathPrefixes}
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(event) => onChange({ excludePathPrefixes: event.target.value })}
            data-testid={`${idPrefix}-excludes`}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-extensions`}>{m.auth_extensions()}</FieldLabel>
        <Input
          id={`${idPrefix}-extensions`}
          value={value.extensions}
          placeholder="mp4, m3u8"
          spellCheck={false}
          className="font-mono text-sm"
          onChange={(event) => onChange({ extensions: event.target.value })}
          data-testid={`${idPrefix}-extensions`}
        />
      </Field>
    </>
  );
}
