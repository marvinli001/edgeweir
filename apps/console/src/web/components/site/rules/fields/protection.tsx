import { RATE_LIMIT_PRESETS } from "@edgeweir/contract";
import {
  RULE_BAN,
  rateLimitKeys,
  respondContentTypes,
  respondStatus,
  validRespondBody,
} from "@edgeweir/rule-engine";
import * as React from "react";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import { Input } from "@/components/arc/input/input";
import { Textarea } from "@/components/arc/textarea/textarea";
import { durationLabel } from "@/components/ban-dialog";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/layout/form";
import { PresetSelect, usePreset } from "@/components/preset-select";
import { IntegerField, NumberField, SwitchField } from "@/components/site/fields";
import { StatusSelect } from "@/components/site/rules/fields/common";
import { HEADER_KEY, keyChoice, LocksContext } from "@/components/site/rules/labels";
import { m } from "@/lib/i18n";
import {
  type Action,
  type ActionOf,
  RULE_BAN_DURATIONS,
  type SkipTarget,
  toggleSkip,
  withAccessLog,
  withRateLimitBan,
  withRespondStatus,
} from "@/lib/rule-actions";

/** A rate limit's status, preset (or limit and window), and key. */
export function RateLimitFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"rate_limit">;
  onChange: (action: Action) => void;
}) {
  const locks = React.useContext(LocksContext);
  const preset = usePreset(
    RATE_LIMIT_PRESETS,
    { limit: a.limit, windowSeconds: a.windowSeconds },
    (rate) => onChange({ ...a, ...rate }),
  );
  return (
    <>
      <StatusSelect
        id={id}
        value={a.statusCode}
        codes={[403, 429]}
        onChange={(statusCode) => onChange({ ...a, statusCode: statusCode as 403 | 429 })}
      />
      <PresetSelect id={`rate-preset-${id}`} value={preset.choice} onChange={preset.choose} />
      {preset.choice === "custom" ? (
        <>
          <NumberField
            id={`limit-${id}`}
            label={m.rules_limit()}
            value={String(a.limit)}
            min={1}
            max={100000}
            onChange={(value) => onChange({ ...a, limit: Number(value) })}
          />
          <NumberField
            id={`window-${id}`}
            label={m.rules_window()}
            value={String(a.windowSeconds)}
            min={1}
            max={3600}
            onChange={(value) => onChange({ ...a, windowSeconds: Number(value) })}
          />
        </>
      ) : null}
      <FormSelect
        id={`key-${id}`}
        label={m.rules_key()}
        value={keyChoice(a.key)}
        options={[
          ...rateLimitKeys.map((key) => ({ value: key, label: key })),
          { value: "header", label: m.rules_key_header() },
        ]}
        onChange={(choice) =>
          onChange({ ...a, key: choice === "header" ? `${HEADER_KEY}x-client-id` : choice })
        }
      />
      {keyChoice(a.key) === "header" ? (
        <Field>
          <FieldLabel htmlFor={`key-header-${id}`}>{m.rules_header()}</FieldLabel>
          <Input
            id={`key-header-${id}`}
            value={a.key.slice(HEADER_KEY.length)}
            onChange={(e) =>
              onChange({ ...a, key: `${HEADER_KEY}${e.target.value.toLowerCase()}` })
            }
          />
        </Field>
      ) : null}
      <IntegerField
        id={`rate-ban-${id}`}
        label={m.rules_rate_ban()}
        value={a.banSeconds ?? 0}
        min={0}
        max={RULE_BAN.rateLimitSeconds.max}
        invalid={(n) => n !== 0 && (n < RULE_BAN.rateLimitSeconds.min || !Number.isInteger(n))}
        disabled={locks.wafV2 && !a.banSeconds}
        onChange={(seconds) => onChange(withRateLimitBan(a, seconds))}
        testId="rule-rate-ban"
      />
    </>
  );
}

/** A log rule's access log line, written whatever the sample rate (waf-v2). */
export function LogFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"log">;
  onChange: (action: Action) => void;
}) {
  const locks = React.useContext(LocksContext);
  return (
    <SwitchField
      id={`access-log-${id}`}
      label={m.rules_log_access_log()}
      checked={a.accessLog === true}
      disabled={locks.wafV2 && a.accessLog !== true}
      onCheckedChange={(on) => onChange(withAccessLog(a, on))}
      testId="rule-log-access-log"
    />
  );
}

/** Select value of a ban duration entered in seconds. */
const CUSTOM = "custom";

/**
 * A ban: how long (a named duration or seconds), where (platform rules: every site), and how
 * much of the address (IPv4 and IPv6 prefix lengths).
 */
export function BanFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"ban">;
  onChange: (action: Action) => void;
}) {
  const locks = React.useContext(LocksContext);
  const [custom, setCustom] = React.useState(() => !RULE_BAN_DURATIONS.includes(a.banSeconds));
  const set = (change: Partial<ActionOf<"ban">>) => onChange({ ...a, ...change });
  const prefixes = (range: { min: number; max: number }) =>
    Array.from({ length: range.max - range.min + 1 }, (_, i) => String(range.max - i)).map(
      (bits) => ({ value: bits, label: `/${bits}` }),
    );
  return (
    <>
      <FormSelect
        id={`ban-duration-${id}`}
        label={m.rules_ban_duration()}
        value={custom ? CUSTOM : String(a.banSeconds)}
        options={[
          ...RULE_BAN_DURATIONS.map((seconds) => ({
            value: String(seconds),
            label: durationLabel(seconds),
          })),
          { value: CUSTOM, label: m.preset_custom() },
        ]}
        onChange={(choice) => {
          setCustom(choice === CUSTOM);
          if (choice !== CUSTOM) set({ banSeconds: Number(choice) });
        }}
        testId="rule-ban-duration"
      />
      {custom ? (
        <IntegerField
          id={`ban-seconds-${id}`}
          label={m.rules_ban_seconds()}
          value={a.banSeconds}
          min={RULE_BAN.seconds.min}
          max={RULE_BAN.seconds.max}
          onChange={(banSeconds) => set({ banSeconds })}
          testId="rule-ban-seconds"
        />
      ) : null}
      {locks.platform ? (
        <FormSelect
          id={`ban-scope-${id}`}
          label={m.rules_ban_scope()}
          value={a.banScope}
          options={[
            { value: "site", label: m.rules_ban_scope_site() },
            { value: "platform", label: m.rules_ban_scope_platform() },
          ]}
          onChange={(scope) => set({ banScope: scope as ActionOf<"ban">["banScope"] })}
          testId="rule-ban-scope"
        />
      ) : null}
      <FormSelect
        id={`ban-v4-${id}`}
        label={m.rules_ban_prefix_v4()}
        value={String(a.banPrefixV4)}
        options={prefixes(RULE_BAN.prefixV4)}
        onChange={(bits) => set({ banPrefixV4: Number(bits) })}
        testId="rule-ban-prefix-v4"
      />
      <FormSelect
        id={`ban-v6-${id}`}
        label={m.rules_ban_prefix_v6()}
        value={String(a.banPrefixV6)}
        options={prefixes(RULE_BAN.prefixV6)}
        onChange={(bits) => set({ banPrefixV6: Number(bits) })}
        testId="rule-ban-prefix-v6"
      />
    </>
  );
}

/**
 * A custom response: the status and either a static body of a content type or the site's error
 * page of the status (4xx and 5xx); 204 has no body.
 */
export function RespondFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"respond">;
  onChange: (action: Action) => void;
}) {
  const set = (change: Partial<ActionOf<"respond">>) => onChange({ ...a, ...change });
  const errorPages = a.statusCode >= 400;
  return (
    <>
      <IntegerField
        id={`respond-status-${id}`}
        label={m.rules_status()}
        value={a.statusCode}
        min={200}
        max={599}
        invalid={(status) => !respondStatus(status)}
        onChange={(status) => onChange(withRespondStatus(a, status))}
        testId="rule-respond-status"
      />
      {errorPages ? (
        <SwitchField
          id={`respond-error-page-${id}`}
          label={m.rules_respond_error_page()}
          checked={a.errorPage}
          // An error page has no body of its own.
          onCheckedChange={(errorPage) => set(errorPage ? { errorPage, body: "" } : { errorPage })}
          testId="rule-respond-error-page"
        />
      ) : null}
      {a.errorPage ? null : (
        <>
          <FormSelect
            id={`respond-type-${id}`}
            label={m.rules_respond_type()}
            value={a.contentType}
            options={respondContentTypes.map((type) => ({ value: type, label: type }))}
            onChange={(type) => set({ contentType: type as ActionOf<"respond">["contentType"] })}
            testId="rule-respond-type"
          />
          {a.statusCode === 204 ? null : (
            <Field
              className="min-w-0 sm:col-span-2"
              data-invalid={!validRespondBody(a.body) || undefined}
            >
              <FieldLabel htmlFor={`respond-body-${id}`}>{m.rules_respond_body()}</FieldLabel>
              <Textarea
                id={`respond-body-${id}`}
                value={a.body}
                rows={3}
                spellCheck={false}
                aria-invalid={!validRespondBody(a.body) || undefined}
                onChange={(e) => set({ body: e.target.value })}
                className="max-h-64 font-mono"
                data-testid="rule-respond-body"
              />
            </Field>
          )}
        </>
      )}
    </>
  );
}

/** What a skip rule skips, in the order a request meets them. */
const SKIP_CHOICES: readonly [SkipTarget, () => string][] = [
  ["rules", m.rules_skip_rules],
  ["rate_limits", m.rules_skip_rate_limits],
  ["crs", m.rules_skip_crs],
  ["challenges", m.rules_skip_challenges],
];

/** The checks a skip rule skips for the request (at least one). */
export function SkipFields({
  id,
  action: a,
  onChange,
}: {
  id: string;
  action: ActionOf<"skip">;
  onChange: (action: Action) => void;
}) {
  return (
    <FieldSet className="gap-2 sm:col-span-2" data-invalid={a.skip.length === 0 || undefined}>
      <FieldLegend variant="label" className="mb-1">
        {m.rules_skip_targets()}
      </FieldLegend>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {SKIP_CHOICES.map(([target, label]) => (
          <Field key={target} orientation="horizontal" className="w-auto">
            <Checkbox
              id={`skip-${target}-${id}`}
              checked={a.skip.includes(target)}
              aria-invalid={a.skip.length === 0 || undefined}
              onCheckedChange={(on) => onChange({ ...a, skip: toggleSkip(a.skip, target, on) })}
              data-testid={`rule-skip-${target}`}
            />
            <FieldLabel htmlFor={`skip-${target}-${id}`} className="font-normal">
              {label()}
            </FieldLabel>
          </Field>
        ))}
      </div>
    </FieldSet>
  );
}
