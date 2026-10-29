import { arrayMove } from "@dnd-kit/sortable";
import {
  type ChallengeType,
  challengeTypes,
  compressionCodings,
  crsOverrides,
  MAX_HOST_HEADER_LENGTH,
  type Phase,
} from "@edgeweir/rule-engine";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/layout/form";
import { NumberField } from "@/components/site/fields";
import {
  type Coding,
  ContentLock,
  codingLabel,
  DEFAULT_GROUP,
  LocksContext,
  UNCHANGED,
} from "@/components/site/rules/labels";
import { m } from "@/lib/i18n";
import { invalidHostHeader } from "@/lib/lists";
import { challengeLabel, wafModeLabel } from "@/lib/protection";
import type { ActionOf } from "@/lib/rule-actions";

/**
 * A number shown in other units than stored (seconds for milliseconds, % for basis points);
 * empty is undefined. The text survives while it means the same value.
 */
function OptionalNumber({
  id,
  label,
  value,
  scale,
  min,
  max,
  disabled,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  value: number | undefined;
  /** Stored units per shown unit. */
  scale: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number | undefined) => void;
  testId?: string;
}) {
  const show = (stored: number | undefined) => (stored === undefined ? "" : String(stored / scale));
  const parse = (text: string) => {
    const n = Number(text);
    return text.trim() === "" || !Number.isFinite(n) ? undefined : Math.round(n * scale);
  };
  const [text, setText] = React.useState(() => show(value));
  return (
    <NumberField
      id={id}
      label={label}
      value={parse(text) === value ? text : show(value)}
      min={min}
      max={max}
      step="any"
      placeholder={m.rules_unchanged()}
      disabled={disabled}
      onChange={(next) => {
        setText(next);
        onChange(parse(next));
      }}
      testId={testId}
    />
  );
}

type ConfigAction = ActionOf<"config">;
/** Overrides every config rule may set (also in the phase cache). */
const BASE_SWITCHES = ["cacheBypass", "forceHttps", "gzip"] as const;
/** Overrides only the phase config accepts (rules-v2). */
const V2_SWITCHES = ["brotli", "zstd", "websocket", "underAttack", "ccEnabled"] as const;
type ConfigSwitch = (typeof BASE_SWITCHES)[number] | (typeof V2_SWITCHES)[number];
const switchLabel = (key: ConfigSwitch) =>
  ({
    cacheBypass: m.rules_bypass,
    forceHttps: m.cert_force_https,
    gzip: m.cert_gzip,
    brotli: m.compression_brotli,
    zstd: m.compression_zstd,
    websocket: m.site_pool_websocket,
    underAttack: m.protection_under_attack,
    ccEnabled: m.cc_title,
  })[key]();

/** Site settings a config rule overrides; unset ones stay as the site has them. */
export function ConfigFields({
  id,
  phase,
  action: a,
  locked,
  onChange,
}: {
  id: string;
  phase: Phase;
  action: ConfigAction;
  locked: boolean;
  onChange: (action: ConfigAction) => void;
}) {
  const set = (change: Partial<ConfigAction>) => onChange({ ...a, ...change });
  // The body limit waits until the cluster's nodes run site-content-v1, the CRS override waf-v2.
  const contentLocked = React.useContext(ContentLock);
  const wafV2Locked = React.useContext(LocksContext).wafV2;
  const triState = (key: ConfigSwitch, v2: boolean) => {
    // Turning gzip back on is new with rules-v2 as well.
    const noOn = locked && (v2 || key === "gzip") && a[key] !== true;
    return (
      <FormSelect
        key={key}
        id={`${key}-${id}`}
        label={switchLabel(key)}
        value={a[key] === undefined ? UNCHANGED : String(a[key])}
        options={[
          { value: UNCHANGED, label: m.rules_unchanged() },
          ...(noOn ? [] : [{ value: "true", label: m.rules_on() }]),
          { value: "false", label: m.rules_off() },
        ]}
        disabled={v2 && locked && a[key] === undefined}
        onChange={(value) =>
          onChange({ ...a, [key]: value === UNCHANGED ? undefined : value === "true" })
        }
        testId={`rule-config-${key}`}
      />
    );
  };
  const timeouts = [
    ["originConnectTimeoutMs", m.rules_connect_timeout(), 120],
    ["originSendTimeoutMs", m.rules_send_timeout(), 3600],
    ["originReadTimeoutMs", m.rules_read_timeout(), 3600],
  ] as const;
  return (
    // Spans the row's grid; three overrides per line where there is room.
    <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2 lg:grid-cols-3">
      {BASE_SWITCHES.map((key) => triState(key, false))}
      {phase === "config" ? (
        <>
          {V2_SWITCHES.map((key) => triState(key, true))}
          <FormSelect
            id={`cc-level-${id}`}
            label={m.rules_cc_max_level()}
            value={a.ccMaxLevel ?? UNCHANGED}
            options={[
              { value: UNCHANGED, label: m.rules_unchanged() },
              ...challengeTypes.map((type) => ({ value: type, label: challengeLabel(type) })),
            ]}
            disabled={locked && a.ccMaxLevel === undefined}
            onChange={(level) =>
              set({ ccMaxLevel: level === UNCHANGED ? undefined : (level as ChallengeType) })
            }
            testId="rule-config-ccMaxLevel"
          />
          {timeouts.map(([key, label, max]) => (
            <OptionalNumber
              key={key}
              id={`${key}-${id}`}
              label={label}
              value={a[key]}
              scale={1000}
              min={0.1}
              max={max}
              disabled={locked && a[key] === undefined}
              onChange={(value) => onChange({ ...a, [key]: value })}
              testId={`rule-config-${key}`}
            />
          ))}
          <OptionalNumber
            id={`log-sample-${id}`}
            label={m.rules_log_sample_rate()}
            value={a.logSampleRate}
            scale={100}
            min={0}
            max={100}
            disabled={locked && a.logSampleRate === undefined}
            onChange={(logSampleRate) => set({ logSampleRate })}
            testId="rule-config-logSampleRate"
          />
          <OptionalNumber
            id={`body-limit-${id}`}
            label={m.rules_request_body_limit()}
            value={a.requestBodyLimit}
            scale={1024 * 1024}
            min={0}
            max={10240}
            disabled={contentLocked && a.requestBodyLimit === undefined}
            onChange={(requestBodyLimit) => set({ requestBodyLimit })}
            testId="rule-config-requestBodyLimit"
          />
          <FormSelect
            id={`crs-${id}`}
            label={m.rules_config_crs()}
            value={a.crs ?? UNCHANGED}
            options={[
              { value: UNCHANGED, label: m.rules_unchanged() },
              ...crsOverrides.map((mode) => ({ value: mode, label: wafModeLabel(mode) })),
            ]}
            disabled={wafV2Locked && a.crs === undefined}
            onChange={(mode) =>
              set({ crs: mode === UNCHANGED ? undefined : (mode as (typeof crsOverrides)[number]) })
            }
            testId="rule-config-crs"
          />
        </>
      ) : null}
    </div>
  );
}

/** Which origin group serves the request, and the Host, SNI and port sent to it. */
export function OriginFields({
  id,
  action: a,
  originGroups,
  onChange,
}: {
  id: string;
  action: ActionOf<"origin">;
  originGroups?: string[];
  onChange: (action: ActionOf<"origin">) => void;
}) {
  const set = (change: Partial<ActionOf<"origin">>) => onChange({ ...a, ...change });
  const hostInvalid = invalidHostHeader(a.hostHeader);
  // A group no origin has any more still shows, so the rule can be pointed elsewhere.
  const groups = originGroups && [
    ...new Set([...originGroups, ...(a.originGroup ? [a.originGroup] : [])]),
  ];
  return (
    <>
      {groups ? (
        <FormSelect
          id={`origin-group-${id}`}
          label={m.rules_origin_group()}
          value={a.originGroup || DEFAULT_GROUP}
          options={[
            { value: DEFAULT_GROUP, label: m.site_origin_group_default() },
            ...groups.map((group) => ({ value: group, label: group })),
          ]}
          onChange={(group) => set({ originGroup: group === DEFAULT_GROUP ? "" : group })}
          testId="rule-origin-group"
        />
      ) : null}
      <Field data-invalid={hostInvalid || undefined}>
        <FieldLabel htmlFor={`origin-host-${id}`}>{m.site_form_host_header()}</FieldLabel>
        <Input
          id={`origin-host-${id}`}
          value={a.hostHeader}
          maxLength={MAX_HOST_HEADER_LENGTH}
          placeholder={m.rules_unchanged()}
          onChange={(e) => set({ hostHeader: e.target.value })}
          aria-invalid={hostInvalid || undefined}
          data-testid="rule-origin-host"
        />
        {hostInvalid ? (
          <FieldError className="animate-in fade-in" data-testid="rule-origin-host-invalid">
            {m.site_form_host_header_invalid()}
          </FieldError>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={`origin-sni-${id}`}>{m.site_origin_sni()}</FieldLabel>
        <Input
          id={`origin-sni-${id}`}
          value={a.sni}
          maxLength={253}
          placeholder={m.rules_unchanged()}
          onChange={(e) => set({ sni: e.target.value })}
          data-testid="rule-origin-sni"
        />
      </Field>
      <OptionalNumber
        id={`origin-port-${id}`}
        label={m.site_form_port()}
        value={a.port || undefined}
        scale={1}
        min={1}
        max={65535}
        onChange={(port) => set({ port: port ?? 0 })}
        testId="rule-origin-port"
      />
    </>
  );
}

/** The codings a response may use, in preference order; none turns compression off. */
export function CompressionFields({
  action: a,
  onChange,
}: {
  action: ActionOf<"compression">;
  onChange: (action: ActionOf<"compression">) => void;
}) {
  const list = a.algorithms;
  const set = (algorithms: Coding[]) => onChange({ ...a, algorithms });
  const remaining = compressionCodings.filter((coding) => !list.includes(coding));
  return (
    <FieldSet className="gap-2 sm:col-span-2">
      <FieldLegend variant="label" className="mb-1">
        {m.rules_compression_order()}
      </FieldLegend>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="rule-compression-none">
          {m.rules_compression_none()}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {list.map((coding, index) => {
            const name = codingLabel(coding);
            return (
              <li
                key={coding}
                className="flex min-h-10 items-center gap-1 rounded-md faint-well py-1 pr-1 pl-3 animate-enter"
                data-testid="rule-compression-algorithm"
                data-coding={coding}
              >
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="flex-1 text-sm">{name}</span>
                <Button
                  className="icon-button"
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={m.rules_compression_up({ name })}
                  disabled={index === 0}
                  onClick={() => set(arrayMove(list, index, index - 1))}
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
                </Button>
                <Button
                  className="icon-button"
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={m.rules_compression_down({ name })}
                  disabled={index === list.length - 1}
                  onClick={() => set(arrayMove(list, index, index + 1))}
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                </Button>
                <Button
                  className="icon-button"
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={m.rules_compression_remove({ name })}
                  onClick={() => set(list.filter((c) => c !== coding))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {remaining.length ? (
        <OptionSelect
          value={null}
          options={remaining.map((coding) => ({ value: coding, label: codingLabel(coding) }))}
          onChange={(coding) => set([...list, coding])}
          placeholder={m.rules_compression_add()}
          label={m.rules_compression_add()}
          size="sm"
          className="self-start"
          testId="rule-compression-add"
        />
      ) : null}
    </FieldSet>
  );
}
