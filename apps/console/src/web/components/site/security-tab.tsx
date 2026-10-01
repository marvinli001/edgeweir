import {
  type AnalyticsRange,
  CHALLENGE_TYPES,
  type ChallengeType,
  type FeatureAvailability,
  PASS_TTL_RANGE,
  POW_DIFFICULTY_RANGE,
  POW_HIGH_DIFFICULTY_RANGE,
  type SecurityEventKind,
  type SiteProtection,
  type SiteProtectionUpdateInput,
  type SiteWaf,
  securityEventKind,
  WAF_ANOMALY_THRESHOLD_RANGE,
  WAF_BODY_LIMIT_RANGE,
  WAF_MAX_EXCLUSIONS,
  WAF_MODES,
  WAF_PARANOIA_RANGE,
  type WafMode,
  wafExcludedRuleIds,
} from "@edgeweir/contract";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import {
  type CcDraft,
  CcThresholdFields,
  fromCcDraft,
  toCcDraft,
} from "@/components/cc-thresholds";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormSelect } from "@/components/form-select";
import { Pager } from "@/components/pager";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ANALYTICS_RANGES, rangeLabel } from "@/lib/analytics";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import {
  challengeLabel,
  eventKindLabel,
  levelLabel,
  metricLabel,
  wafModeLabel,
} from "@/lib/protection";

const PAGE_SIZE = 20;
const ALL = "all";
const HOURS = [1, 24, 168] as const;

/** Saves part of the site's protection and refreshes it; returns whether it worked. */
function useUpdateProtection(siteId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.protection.update.mutationOptions());
  const [error, setError] = React.useState<string | null>(null);
  const save = async (patch: Omit<SiteProtectionUpdateInput, "id">) => {
    setError(null);
    try {
      const saved = await mutation.mutateAsync({ id: siteId, ...patch });
      queryClient.setQueryData(orpc.protection.get.queryKey({ input: { id: siteId } }), saved);
      toast.success(m.common_saved());
      return true;
    } catch (err) {
      setError(errorMessage(err));
      toast.error(errorMessage(err));
      return false;
    }
  };
  return { save, error, pending: mutation.isPending };
}

/** The site's security tab: Under Attack, challenges, CC policy and what the nodes report. */
export function SecurityTab({ siteId }: { siteId: string }) {
  const protection = useQuery(orpc.protection.get.queryOptions({ input: { id: siteId } }));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {protection.isPending ? (
        <LoadingState />
      ) : protection.isError ? (
        <ErrorState error={protection.error} onRetry={() => void protection.refetch()} />
      ) : (
        <>
          <UnderAttackCard siteId={siteId} protection={protection.data} />
          <ChallengeSettingsCard
            key={`challenge-${protection.data.updatedAt}`}
            siteId={siteId}
            protection={protection.data}
          />
          <CcPolicyCard
            key={`cc-${protection.data.updatedAt}`}
            siteId={siteId}
            protection={protection.data}
          />
        </>
      )}
      <WafCard siteId={siteId} />
      <NodeLevelsCard siteId={siteId} />
      <TopCard siteId={siteId} />
      <WafRulesCard siteId={siteId} />
      <EventsCard siteId={siteId} />
    </div>
  );
}

function UnderAttackCard({ siteId, protection }: { siteId: string; protection: SiteProtection }) {
  const { save, pending } = useUpdateProtection(siteId);
  const turningOn = !protection.underAttack;
  const toggle = (
    <Switch
      id="protection-under-attack"
      checked={protection.underAttack}
      disabled={pending}
      data-testid="protection-under-attack"
    />
  );
  return (
    <Card className="animate-enter">
      <CardHeader>
        <CardTitle>{m.protection_under_attack()}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field orientation="horizontal" className="min-h-9 w-auto self-end">
          <ConfirmDialog
            trigger={toggle}
            destructive={turningOn}
            title={turningOn ? m.protection_under_attack_on() : m.protection_under_attack_off()}
            note={turningOn ? m.protection_under_attack_on_note() : undefined}
            confirmLabel={turningOn ? m.protection_turn_on() : m.protection_turn_off()}
            onConfirm={() => save({ underAttack: turningOn })}
          />
          <FieldLabel htmlFor="protection-under-attack">{m.protection_under_attack()}</FieldLabel>
          {protection.underAttack ? (
            <Badge variant="destructive" data-testid="protection-under-attack-on">
              {m.protection_on()}
            </Badge>
          ) : null}
        </Field>
        <FormSelect
          id="protection-under-attack-type"
          label={m.rules_challenge_type()}
          value={protection.underAttackChallenge}
          disabled={pending}
          testId="protection-under-attack-type"
          options={CHALLENGE_TYPES.map((type) => ({ value: type, label: challengeLabel(type) }))}
          onChange={(type) => void save({ underAttackChallenge: type as ChallengeType })}
        />
        {protection.platformUnderAttack ? (
          <SafetyNote className="sm:col-span-2" data-testid="protection-platform-on">
            {m.protection_platform_on()}
          </SafetyNote>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ChallengeSettingsCard({
  siteId,
  protection,
}: {
  siteId: string;
  protection: SiteProtection;
}) {
  const { save, error, pending } = useUpdateProtection(siteId);
  const initial = {
    passTtlSeconds: String(protection.passTtlSeconds),
    powDifficulty: String(protection.powDifficulty),
    powHighDifficulty: String(protection.powHighDifficulty),
    logJa4: protection.logJa4,
  };
  const [draft, setDraft] = React.useState(initial);
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            passTtlSeconds: Number(draft.passTtlSeconds),
            powDifficulty: Number(draft.powDifficulty),
            powHighDifficulty: Number(draft.powHighDifficulty),
            logJa4: draft.logJa4,
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.protection_challenge_title()}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField
            id="protection-pass-ttl"
            label={m.protection_pass_ttl()}
            value={draft.passTtlSeconds}
            min={PASS_TTL_RANGE.min}
            max={PASS_TTL_RANGE.max}
            step={1}
            required
            testId="protection-pass-ttl"
            onChange={(passTtlSeconds) => setDraft({ ...draft, passTtlSeconds })}
          />
          <NumberField
            id="protection-pow"
            label={m.protection_pow()}
            value={draft.powDifficulty}
            min={POW_DIFFICULTY_RANGE.min}
            max={POW_DIFFICULTY_RANGE.max}
            step={1}
            required
            testId="protection-pow"
            onChange={(powDifficulty) => setDraft({ ...draft, powDifficulty })}
          />
          <NumberField
            id="protection-pow-high"
            label={m.protection_pow_high()}
            value={draft.powHighDifficulty}
            min={Math.max(POW_HIGH_DIFFICULTY_RANGE.min, Number(draft.powDifficulty) || 0)}
            max={POW_HIGH_DIFFICULTY_RANGE.max}
            step={1}
            required
            testId="protection-pow-high"
            onChange={(powHighDifficulty) => setDraft({ ...draft, powHighDifficulty })}
          />
          <SwitchField
            id="protection-log-ja4"
            label={m.protection_log_ja4()}
            checked={draft.logJa4}
            testId="protection-log-ja4"
            onCheckedChange={(logJa4) => setDraft({ ...draft, logJa4 })}
          />
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
          pending={pending}
          error={error}
          testId="protection-save"
        />
      </form>
    </Card>
  );
}

function CcPolicyCard({ siteId, protection }: { siteId: string; protection: SiteProtection }) {
  const { save, error, pending } = useUpdateProtection(siteId);
  const initial = {
    enabled: protection.cc.enabled,
    followTemplate: protection.cc.followTemplate,
    thresholds: toCcDraft(protection.cc),
  };
  const [draft, setDraft] = React.useState(initial);
  // While following, the fields show the platform template.
  const shown: CcDraft = draft.followTemplate ? toCcDraft(protection.ccTemplate) : draft.thresholds;
  return (
    <Card className="animate-enter" style={{ animationDelay: "120ms" }}>
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            cc: {
              enabled: draft.enabled,
              followTemplate: draft.followTemplate,
              ...(draft.followTemplate ? {} : fromCcDraft(draft.thresholds)),
            },
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.cc_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <SwitchField
              id="cc-enabled"
              label={m.cc_enabled()}
              checked={draft.enabled}
              testId="cc-enabled"
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            <SwitchField
              id="cc-follow-template"
              label={m.cc_follow_template()}
              checked={draft.followTemplate}
              testId="cc-follow-template"
              onCheckedChange={(followTemplate) =>
                setDraft({
                  ...draft,
                  followTemplate,
                  // Custom thresholds start from the template the site followed.
                  thresholds: followTemplate ? draft.thresholds : shown,
                })
              }
            />
          </div>
          <CcThresholdFields
            prefix="cc"
            value={shown}
            disabled={draft.followTemplate}
            onChange={(thresholds) => setDraft({ ...draft, thresholds })}
          />
          <SafetyNote>{m.cc_per_node_note()}</SafetyNote>
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
          pending={pending}
          error={error}
          testId="cc-save"
        />
      </form>
    </Card>
  );
}

/** The site's OWASP CRS: mode, paranoia level, threshold, exclusions and body limit. */
function WafCard({ siteId }: { siteId: string }) {
  const waf = useQuery(orpc.waf.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Card className="animate-enter" style={{ animationDelay: "150ms" }} data-testid="waf-card">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle>{m.waf_title()}</CardTitle>
        {waf.data && waf.data.mode !== "off" ? (
          <Badge
            variant={waf.data.mode === "block" ? "destructive" : "secondary"}
            data-testid="waf-mode-badge"
          >
            {wafModeLabel(waf.data.mode)}
          </Badge>
        ) : null}
      </CardHeader>
      {waf.isPending || features.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : waf.isError ? (
        <CardContent>
          <ErrorState error={waf.error} onRetry={() => void waf.refetch()} />
        </CardContent>
      ) : features.isError ? (
        <CardContent>
          <ErrorState error={features.error} onRetry={() => void features.refetch()} />
        </CardContent>
      ) : (
        <WafForm
          key={waf.data.updatedAt ?? "default"}
          siteId={siteId}
          waf={waf.data}
          availability={features.data.crs}
        />
      )}
    </Card>
  );
}

/** "942100, 920350 941100" → sorted unique ids, or null when a token is not a CRS rule id. */
function parseRuleIds(value: string): number[] | null {
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  if (!tokens.every((token) => /^\d{6}$/.test(token))) return null;
  return tokens.map(Number);
}

function WafForm({
  siteId,
  waf,
  availability,
}: {
  siteId: string;
  waf: SiteWaf;
  availability: FeatureAvailability;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.waf.update.mutationOptions());
  const initial = {
    mode: waf.mode,
    paranoiaLevel: String(waf.paranoiaLevel),
    anomalyThreshold: String(waf.anomalyThreshold),
    requestBodyLimit: String(waf.requestBodyLimit),
    excludedRuleIds: waf.excludedRuleIds,
  };
  const [draft, setDraft] = React.useState(initial);
  const [ruleInput, setRuleInput] = React.useState("");
  const [ruleError, setRuleError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Turning CRS on needs the feature; a site that runs it can still be turned off.
  const locked = !availability.available && waf.mode === "off";
  const invalidRules = () => m.waf_exclusions_invalid({ max: WAF_MAX_EXCLUSIONS });
  const addRules = () => {
    const ids = parseRuleIds(ruleInput);
    const next = ids
      ? [...new Set([...draft.excludedRuleIds, ...ids])].sort((a, b) => a - b)
      : null;
    if (!next || !wafExcludedRuleIds.safeParse(next).success) {
      setRuleError(invalidRules());
      return;
    }
    setRuleError(null);
    setRuleInput("");
    setDraft({ ...draft, excludedRuleIds: next });
  };
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          const saved = await mutation.mutateAsync({
            id: siteId,
            mode: draft.mode,
            paranoiaLevel: Number(draft.paranoiaLevel),
            anomalyThreshold: Number(draft.anomalyThreshold),
            requestBodyLimit: Number(draft.requestBodyLimit),
            excludedRuleIds: draft.excludedRuleIds,
          });
          queryClient.setQueryData(orpc.waf.get.queryKey({ input: { id: siteId } }), saved);
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FormSelect
            id="waf-mode"
            label={m.waf_mode()}
            value={draft.mode}
            disabled={locked}
            testId="waf-mode"
            options={WAF_MODES.map((mode) => ({ value: mode, label: wafModeLabel(mode) }))}
            onChange={(mode) => setDraft({ ...draft, mode: mode as WafMode })}
          />
          <FormSelect
            id="waf-paranoia"
            label={m.waf_paranoia()}
            value={draft.paranoiaLevel}
            testId="waf-paranoia"
            options={Array.from(
              { length: WAF_PARANOIA_RANGE.max - WAF_PARANOIA_RANGE.min + 1 },
              (_, i) => String(WAF_PARANOIA_RANGE.min + i),
            ).map((level) => ({ value: level, label: m.waf_paranoia_value({ level }) }))}
            onChange={(paranoiaLevel) => setDraft({ ...draft, paranoiaLevel })}
          />
          <NumberField
            id="waf-threshold"
            label={m.waf_threshold()}
            value={draft.anomalyThreshold}
            min={WAF_ANOMALY_THRESHOLD_RANGE.min}
            max={WAF_ANOMALY_THRESHOLD_RANGE.max}
            step={1}
            required
            testId="waf-threshold"
            onChange={(anomalyThreshold) => setDraft({ ...draft, anomalyThreshold })}
          />
          <NumberField
            id="waf-body-limit"
            label={m.waf_body_limit()}
            value={draft.requestBodyLimit}
            min={WAF_BODY_LIMIT_RANGE.min}
            max={WAF_BODY_LIMIT_RANGE.max}
            step={1}
            required
            testId="waf-body-limit"
            onChange={(requestBodyLimit) => setDraft({ ...draft, requestBodyLimit })}
          />
        </div>
        <Field data-invalid={ruleError ? true : undefined}>
          <FieldLabel htmlFor="waf-exclusion-input">{m.waf_exclusions()}</FieldLabel>
          <div className="flex min-w-0 gap-2">
            <Input
              id="waf-exclusion-input"
              className="min-w-0 flex-1 font-mono"
              inputMode="numeric"
              value={ruleInput}
              aria-invalid={ruleError ? true : undefined}
              data-testid="waf-exclusion-input"
              onChange={(event) => {
                setRuleInput(event.target.value);
                setRuleError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addRules();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!ruleInput.trim()}
              data-testid="waf-exclusion-add"
              onClick={addRules}
            >
              {m.waf_exclusions_add()}
            </Button>
          </div>
          {ruleError ? (
            <FieldError data-testid="waf-exclusion-error">{ruleError}</FieldError>
          ) : null}
          {draft.excludedRuleIds.length ? (
            <ul className="flex flex-wrap gap-1.5" data-testid="waf-exclusions">
              {draft.excludedRuleIds.map((id) => (
                <li key={id}>
                  <Badge
                    variant="outline"
                    className="gap-1 font-mono tabular-nums"
                    data-testid="waf-exclusion"
                    data-rule-id={id}
                  >
                    {id}
                    <button
                      type="button"
                      className="-mr-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label={m.waf_exclusions_remove({ id: String(id) })}
                      data-testid="waf-exclusion-remove"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          excludedRuleIds: draft.excludedRuleIds.filter((rule) => rule !== id),
                        })
                      }
                    >
                      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </Field>
        {availability.available ? null : (
          <SafetyNote data-testid="waf-unavailable" data-reason={availability.reason ?? undefined}>
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        )}
      </CardContent>
      <SaveBar
        dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
        pending={mutation.isPending}
        error={error}
        testId="waf-save"
      />
    </form>
  );
}

/** Most-matched CRS rules of the site over a range (approximate). */
function WafRulesCard({ siteId }: { siteId: string }) {
  const [range, setRange] = React.useState<AnalyticsRange>("24h");
  const rules = useQuery({
    ...orpc.waf.topRules.queryOptions({ input: { id: siteId, range, limit: 10 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "270ms" }}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.waf_top_title()}</CardTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="waf-top-range"
            label={m.security_hours()}
            value={range}
            testId="waf-top-range"
            options={ANALYTICS_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
            onChange={(value) => setRange(value as AnalyticsRange)}
          />
        </div>
      </CardHeader>
      <CardContent>
        {rules.isPending ? (
          <LoadingState />
        ) : rules.isError ? (
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
        ) : (
          <TopList
            title={m.waf_top_rules()}
            items={rules.data.items.map((item) => ({
              value: String(item.ruleId),
              count: item.requests,
            }))}
            testId="waf-top-rules"
            mono
          />
        )}
      </CardContent>
    </Card>
  );
}

function NodeLevelsCard({ siteId }: { siteId: string }) {
  const state = useQuery(
    orpc.security.state.queryOptions({
      input: { id: siteId, hours: 24 },
      refetchInterval: 15_000,
      meta: { background: true },
    }),
  );
  return (
    <Card className="animate-enter" style={{ animationDelay: "180ms" }}>
      <CardHeader>
        <CardTitle>{m.security_nodes_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        {state.isPending ? (
          <LoadingState />
        ) : state.isError ? (
          <ErrorState error={state.error} onRetry={() => void state.refetch()} />
        ) : state.data.nodes.length === 0 ? (
          <EmptyState title={m.security_no_nodes()} />
        ) : (
          <ul className="divide-y rounded-2xl border" data-testid="security-nodes">
            {state.data.nodes.map((node, index) => (
              <li
                key={node.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 animate-enter"
                style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                data-testid="security-node-row"
                data-node-id={node.id}
                data-level={node.level}
              >
                <span className="min-w-32 flex-1 truncate text-sm font-medium">{node.name}</span>
                <StatusDot tone={node.online ? "good" : "idle"}>
                  {node.online ? m.security_online() : m.security_offline()}
                </StatusDot>
                <Badge
                  variant={node.level === "normal" ? "outline" : "destructive"}
                  data-testid="security-node-level"
                >
                  {levelLabel(node.level)}
                </Badge>
                {node.escalatedPaths ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {m.security_escalated_paths({ count: formatNumber(node.escalatedPaths) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TopList({
  title,
  items,
  testId,
  mono,
}: {
  title: string;
  items: { value: string; count: number }[];
  testId: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.security_top_empty()}</p>
      ) : (
        <ol className="divide-y rounded-2xl border">
          {items.map((item) => (
            <li key={item.value} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-xs" : ""}`}>
                {item.value}
              </span>
              <span className="tabular-nums text-muted-foreground">{formatNumber(item.count)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TopCard({ siteId }: { siteId: string }) {
  const [hours, setHours] = React.useState<(typeof HOURS)[number]>(24);
  const state = useQuery({
    ...orpc.security.state.queryOptions({ input: { id: siteId, hours } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "240ms" }}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.security_top_title()}</CardTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="security-hours"
            label={m.security_hours()}
            value={String(hours)}
            testId="security-hours"
            options={HOURS.map((value) => ({
              value: String(value),
              label: m.security_hours_value({ hours: value }),
            }))}
            onChange={(value) => setHours(Number(value) as (typeof HOURS)[number])}
          />
        </div>
      </CardHeader>
      <CardContent>
        {state.isPending ? (
          <LoadingState />
        ) : state.isError ? (
          <ErrorState error={state.error} onRetry={() => void state.refetch()} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <TopList
              title={m.security_top_ips()}
              items={state.data.topIps}
              testId="security-top-ips"
              mono
            />
            <TopList
              title={m.security_top_paths()}
              items={state.data.topPaths}
              testId="security-top-paths"
              mono
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EventsCard({ siteId }: { siteId: string }) {
  const [page, setPage] = React.useState(1);
  const [kind, setKind] = React.useState<SecurityEventKind | undefined>();
  const events = useQuery({
    ...orpc.security.events.queryOptions({
      input: { id: siteId, kind, page, pageSize: PAGE_SIZE },
    }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    meta: { background: true },
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "300ms" }}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.security_events_title()}</CardTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="security-event-kind"
            label={m.security_event_kind()}
            value={kind ?? ALL}
            testId="security-event-kind"
            options={[
              { value: ALL, label: m.security_event_kind_all() },
              ...securityEventKind.options.map((value) => ({
                value,
                label: eventKindLabel(value),
              })),
            ]}
            onChange={(value) => {
              setPage(1);
              setKind(value === ALL ? undefined : (value as SecurityEventKind));
            }}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {events.isPending ? (
          <LoadingState />
        ) : events.isError ? (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
        ) : events.data.items.length === 0 ? (
          <EmptyState title={m.security_events_empty()} />
        ) : (
          <>
            <ol className="flex flex-col gap-2" data-testid="security-events">
              {events.data.items.map((event, index) => (
                <li
                  key={event.id}
                  className="flex flex-col gap-1 rounded-2xl border px-3 py-2.5 animate-enter"
                  style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                  data-testid="security-event-row"
                  data-kind={event.kind}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={event.kind === "ip_banned" ? "destructive" : "secondary"}>
                      {eventKindLabel(event.kind)}
                    </Badge>
                    {event.kind === "ip_banned" ? (
                      <span className="font-mono text-xs break-all">{event.address}</span>
                    ) : (
                      <span>
                        {m.security_level_change({
                          from: levelLabel(event.previousLevel),
                          to: levelLabel(event.level),
                        })}
                      </span>
                    )}
                    {event.path ? (
                      <span className="font-mono text-xs break-all">{event.path}</span>
                    ) : null}
                    <span
                      className="ml-auto text-xs text-muted-foreground"
                      title={formatDateTime(event.occurredAt)}
                    >
                      {timeAgo(event.occurredAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{event.node?.name || m.security_node_deleted()}</span>
                    {event.metric ? (
                      <span className="tabular-nums">
                        {m.security_metric_value({
                          metric: metricLabel(event.metric),
                          observed: formatNumber(event.observed),
                          threshold: formatNumber(event.threshold),
                        })}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={events.data.total}
              onPageChange={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
