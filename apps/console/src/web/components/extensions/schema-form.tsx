import {
  EXTENSION_SECRET_MASK,
  type ExtensionConfigProperty,
  type ExtensionConfigSchema,
  type ExtensionText,
} from "@edgeweir/contract";
import type * as React from "react";
import { Input } from "@/components/arc/input/input";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldLabel } from "@/components/layout/form";
import { ListInput, SwitchField } from "@/components/site/fields";
import { getLocale } from "@/lib/i18n";

/** A publisher's text in the console's language (English when it has none). */
export function localizedText(text: ExtensionText | undefined, fallback = ""): string {
  if (text === undefined) return fallback;
  if (typeof text === "string") return text;
  return text[getLocale() === "zh-CN" ? "zh-CN" : "en"] ?? text.en ?? fallback;
}

/** A configuration while it is edited: numbers as text, lists as strings. */
export type ConfigDraft = Record<string, string | boolean | string[]>;

/** The form's draft of a configuration (masked secrets stay masked), defaults filled in. */
export function configDraft(
  schema: ExtensionConfigSchema | null | undefined,
  value: Record<string, unknown>,
): ConfigDraft {
  const draft: ConfigDraft = {};
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const given = value[name] ?? property.default;
    switch (property.type) {
      case "boolean":
        draft[name] = given === true;
        break;
      case "array":
        draft[name] = Array.isArray(given) ? given.map(String) : [];
        break;
      default:
        draft[name] = given === undefined || given === null ? "" : String(given);
    }
  }
  return draft;
}

/**
 * The configuration a draft stands for. Empty optional values are left out so that their
 * defaults apply; the server checks the rest against the schema.
 */
export function configFromDraft(
  schema: ExtensionConfigSchema | null | undefined,
  draft: ConfigDraft,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const value = draft[name];
    if (property.type === "boolean") {
      out[name] = value === true;
    } else if (property.type === "array") {
      const list = Array.isArray(value) ? value : [];
      out[name] = property.items.type === "integer" ? list.map(Number) : list;
    } else if (typeof value === "string") {
      if (value === "") continue;
      out[name] = property.type === "string" ? value : Number(value);
    }
  }
  return out;
}

function PropertyField({
  id,
  name,
  property,
  required,
  value,
  onChange,
  disabled,
}: {
  id: string;
  name: string;
  property: ExtensionConfigProperty;
  required: boolean;
  value: string | boolean | string[] | undefined;
  onChange: (value: string | boolean | string[]) => void;
  disabled?: boolean;
}) {
  const label = localizedText(property.title, name);
  const hint = localizedText(property.description) || undefined;
  if (property.type === "boolean") {
    return (
      <SwitchField
        id={id}
        label={label}
        checked={value === true}
        onCheckedChange={onChange}
        disabled={disabled}
        className="self-start"
        testId={`extension-config-${name}`}
      />
    );
  }
  const text = typeof value === "string" ? value : "";
  let control: React.ReactNode;
  if (property.type === "array") {
    control = (
      <ListInput
        id={id}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        disabled={disabled}
        testId={`extension-config-${name}`}
      />
    );
  } else if (property.enum) {
    const options = property.enum.map((option) => ({
      value: String(option),
      label: String(option),
    }));
    control = (
      <OptionSelect
        id={id}
        value={text === "" ? null : text}
        options={options}
        onChange={onChange}
        disabled={disabled}
        testId={`extension-config-${name}`}
      />
    );
  } else if (property.type === "string") {
    const secret = property["x-secret"] === true;
    control = (
      <Input
        id={id}
        type={secret ? "password" : "text"}
        value={text}
        required={required}
        maxLength={property.maxLength}
        disabled={disabled}
        autoComplete={secret ? "new-password" : "off"}
        spellCheck={false}
        // A masked secret is cleared on focus: typing replaces it, leaving it keeps it.
        onFocus={(event) => {
          if (secret && text && text === EXTENSION_SECRET_MASK) event.currentTarget.select();
        }}
        onChange={(event) => onChange(event.target.value)}
        className={property.format ? "font-mono" : undefined}
        data-testid={`extension-config-${name}`}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={property.type === "integer" ? 1 : "any"}
        min={property.minimum}
        max={property.maximum}
        value={text}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="tabular-nums"
        data-testid={`extension-config-${name}`}
      />
    );
  }
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id} title={hint}>
        {label}
      </FieldLabel>
      {control}
    </Field>
  );
}

/**
 * The fields of an extension's configuration schema (the manifest's subset of JSON Schema):
 * switches, text and number inputs, selects for enums, lists; `x-secret` strings as password
 * inputs that keep the stored value while they show the mask.
 */
export function SchemaForm({
  schema,
  draft,
  onChange,
  idPrefix,
  disabled,
}: {
  schema: ExtensionConfigSchema | null | undefined;
  draft: ConfigDraft;
  onChange: (draft: ConfigDraft) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([name, property]) => (
    <PropertyField
      key={name}
      id={`${idPrefix}-${name}`}
      name={name}
      property={property}
      required={required.has(name)}
      value={draft[name]}
      onChange={(value) => onChange({ ...draft, [name]: value })}
      disabled={disabled}
    />
  ));
}

/** Whether a schema has fields to show. */
export function hasConfigFields(schema: ExtensionConfigSchema | null | undefined): boolean {
  return Object.keys(schema?.properties ?? {}).length > 0;
}
