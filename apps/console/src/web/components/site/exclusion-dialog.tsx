import * as React from "react";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import {
  type Exclusion,
  type ExclusionForm,
  readExclusionForm,
  toExclusionForm,
} from "@/lib/waf-exclusions";

/**
 * One CRS exclusion: the path (empty: every path) as a prefix or exactly, the rule ids, and
 * optionally the targets they stop inspecting. `blocked` (the cluster's nodes lack waf-v2) says
 * so and keeps it from being added; `requirePath` refuses an empty path.
 */
export function ExclusionDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  initial,
  requirePath = false,
  blocked = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initial: Exclusion;
  requirePath?: boolean;
  blocked?: boolean;
  onSubmit: (entry: Exclusion) => Promise<void>;
}) {
  const [form, setForm] = React.useState<ExclusionForm>(() => toExclusionForm(initial));
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const set = (change: Partial<ExclusionForm>) => {
    setForm({ ...form, ...change });
    setInvalid(null);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      submitLabel={submitLabel}
      submitTestId="exclusion-submit"
      submitDisabled={blocked}
      onSubmit={async () => {
        const read = readExclusionForm(form, { requirePath });
        if (read.field) {
          setInvalid(read.field);
          throw new Error(read.message);
        }
        await onSubmit(read.entry);
      }}
    >
      {blocked ? (
        <SafetyNote className="animate-in fade-in" data-testid="exclusion-unavailable">
          {m.feature_unavailable_nodes()}
        </SafetyNote>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <Field data-invalid={invalid === "path" || undefined}>
          <FieldLabel htmlFor="exclusion-path">{m.waf_exclusion_path()}</FieldLabel>
          <Input
            id="exclusion-path"
            value={form.path}
            maxLength={1024}
            autoComplete="off"
            spellCheck={false}
            placeholder={requirePath ? "/upload" : m.waf_exclusion_whole_site()}
            aria-invalid={invalid === "path" || undefined}
            onChange={(e) => set({ path: e.target.value })}
            className="font-mono"
            data-testid="exclusion-path"
          />
        </Field>
        <FormSelect
          id="exclusion-match"
          label={m.waf_exclusion_match()}
          value={form.exact ? "exact" : "prefix"}
          disabled={form.path.trim() === ""}
          options={[
            { value: "prefix", label: m.waf_exclusion_prefix() },
            { value: "exact", label: m.waf_exclusion_exact() },
          ]}
          onChange={(match) => set({ exact: match === "exact" })}
          testId="exclusion-match"
        />
      </div>
      <Field data-invalid={invalid === "ruleIds" || undefined}>
        <FieldLabel htmlFor="exclusion-rule-ids">{m.waf_exclusion_rule_ids()}</FieldLabel>
        <Input
          id="exclusion-rule-ids"
          value={form.ruleIds}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="942100, 941100"
          aria-invalid={invalid === "ruleIds" || undefined}
          onChange={(e) => set({ ruleIds: e.target.value })}
          className="font-mono"
          data-testid="exclusion-rule-ids"
        />
      </Field>
      <Field data-invalid={invalid === "targets" || undefined}>
        <FieldLabel htmlFor="exclusion-targets">{m.waf_exclusion_targets()}</FieldLabel>
        <Input
          id="exclusion-targets"
          value={form.targets}
          autoComplete="off"
          spellCheck={false}
          placeholder="ARGS:q, REQUEST_COOKIES:session"
          aria-invalid={invalid === "targets" || undefined}
          onChange={(e) => set({ targets: e.target.value })}
          className="font-mono"
          data-testid="exclusion-targets"
        />
      </Field>
    </FormDialog>
  );
}
