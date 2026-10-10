import {
  type AnalyticsRange,
  CC_LEVELS,
  CC_PRESETS,
  CHALLENGE_PRESETS,
  CHALLENGE_TEXT_MAX,
  CHALLENGE_TYPES,
  type ChallengeText,
  type ChallengeType,
  crsDetectionRule,
  FAILURE_BAN_DEFAULTS,
  FAILURE_BAN_SECONDS_RANGE,
  FAILURE_THRESHOLD_RANGE,
  type FeatureAvailability,
  matchPreset,
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
  WAF_MAX_EXCLUSION_ENTRIES,
  WAF_MAX_EXCLUSIONS,
  WAF_MODES,
  WAF_PARANOIA_RANGE,
  WAF_PRESETS,
  type WafMode,
  wafExcludedRuleIds,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { PresetSelect, presetLabel, usePreset } from "@/components/preset-select";
import { RowMenu, type RowMenuItem } from "@/components/quick-actions";
import { SafetyNote } from "@/components/safety-note";
import { ExclusionDialog } from "@/components/site/exclusion-dialog";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDialogState } from "@/hooks/use-dialog-state";
import { useDraft } from "@/hooks/use-draft";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { blockReasonLabel } from "@/lib/access-logs";
import { ANALYTICS_RANGES, rangeLabel } from "@/lib/analytics";
import { formatDateTime, formatNumber, formatPercent, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import {
  challengeLabel,
  eventKindLabel,
  levelLabel,
  metricLabel,
  wafModeLabel,
} from "@/lib/protection";
import { cn } from "@/lib/utils";
import {
  type Exclusion,
  isSiteWide,
  needsWafV2,
  parseRuleIds,
  siteWideRuleIds,
  unexcludable,
  withSiteWideRuleIds,
} from "@/lib/waf-exclusions";

const PAGE_SIZE = 20;
const ALL = "all";
const HOURS = [1, 24, 168] as const;

/** Saves part of the site's protection and refreshes it; returns whether it worked. */
function useUpdateProtection(siteId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.protection.update.mutationOptions());
  const [error, setError] = React.useState<string | null>(null);
  /** Saves or throws (for confirmations, which show the failure themselves). */
  const apply = async (patch: Omit<SiteProtectionUpdateInput, "id">) => {
    const saved = await mutation.mutateAsync({ id: siteId, ...patch });
    queryClient.setQueryData(orpc.protection.get.queryKey({ input: { id: siteId } }), saved);
    toast.success(m.common_saved());
  };
  const save = async (patch: Omit<SiteProtectionUpdateInput, "id">) => {
    setError(null);
    try {
      await apply(patch);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      toast.error(errorMessage(err));
      return false;
    }
  };
  return { apply, save, error, pending: mutation.isPending };
}

/** The site's security tab: Under Attack, challenges, CC policy and what the nodes report. */
export function SecurityTab({ siteId }: { siteId: string }) {
  const protection = useQuery(orpc.protection.get.queryOptions({ input: { id: siteId } }));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {protection.data ? <SecuritySummary siteId={siteId} protection={protection.data} /> : null}
        {/* Access control outside this tab: the site's bans, global rules, platform defaults. */}
        <div className="flex flex-wrap justify-end gap-2" data-testid="security-links">
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<Link to="/bans" search={{ site: siteId }} data-testid="security-site-bans" />}
          >
            {m.security_site_bans()}
          </Button>
          <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/rules" />}>
            {m.rules_platform()}
          </Button>
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<Link to="/protection" />}
          >
            {m.protection_page_title()}
          </Button>
        </div>
      </div>
      <QueryView query={protection}>
        {(data) => (
          <>
            <UnderAttackCard siteId={siteId} protection={data} />
            <ChallengeSettingsCard siteId={siteId} protection={data} />
            <CcPolicyCard siteId={siteId} protection={data} />
          </>
        )}
      </QueryView>
      <WafCard siteId={siteId} />
      <NodeLevelsCard siteId={siteId} />
      <TopCard siteId={siteId} />
      <WafRulesCard siteId={siteId} />
      <LoggedRulesCard siteId={siteId} />
      <AuthFailuresCard siteId={siteId} />
      <BlockReasonsCard siteId={siteId} />
      <ChallengesCard siteId={siteId} />
      <EventsCard siteId={siteId} />
    </div>
  );
}

/** Where each part of the summary scrolls to. */
const CARD_IDS = {
  underAttack: "security-under-attack",
  challenges: "security-challenges",
  cc: "security-cc",
  waf: "security-waf",
  nodes: "security-nodes",
} as const;

/**
 * One line of what is in effect: Under Attack, the CC policy, CRS, challenges and, when raised,
 * the nodes' level. Each part scrolls to its card.
 */
function SecuritySummary({ siteId, protection }: { siteId: string; protection: SiteProtection }) {
  const reducedMotion = useReducedMotion();
  const waf = useQuery(orpc.waf.get.queryOptions({ input: { id: siteId } }));
  const state = useQuery(
    orpc.security.state.queryOptions({
      input: { id: siteId, hours: 24 },
      refetchInterval: 15_000,
      meta: { background: true },
    }),
  );
  const cc = protection.cc;
  const levels = (state.data?.nodes ?? [])
    .filter((node) => node.online && node.level !== "normal")
    .map((node) => CC_LEVELS.indexOf(node.level));
  const top = levels.length ? CC_LEVELS[Math.max(...levels)] : undefined;
  const parts: { key: keyof typeof CARD_IDS; label: string; alert?: boolean }[] = [
    protection.underAttack || protection.platformUnderAttack
      ? {
          key: "underAttack",
          label: protection.underAttack
            ? m.security_summary_under_attack_on()
            : m.security_summary_under_attack_platform(),
          alert: true,
        }
      : { key: "underAttack", label: m.security_summary_under_attack_off() },
    {
      key: "cc",
      label: m.security_summary_cc({
        state: !cc.enabled
          ? m.security_summary_off()
          : cc.followTemplate
            ? m.security_summary_template()
            : presetLabel(matchPreset(CC_PRESETS, protection.effectiveCc ?? cc) ?? "custom"),
      }),
    },
    ...(waf.data
      ? [
          {
            key: "waf" as const,
            label:
              waf.data.mode === "off"
                ? m.security_summary_crs({ mode: wafModeLabel("off") })
                : m.security_summary_crs_preset({
                    mode: wafModeLabel(waf.data.mode),
                    preset: presetLabel(matchPreset(WAF_PRESETS, waf.data) ?? "custom"),
                  }),
          },
        ]
      : []),
    {
      key: "challenges",
      label: m.security_summary_challenge({
        preset: presetLabel(matchPreset(CHALLENGE_PRESETS, protection) ?? "custom"),
      }),
    },
    ...(top
      ? [
          {
            key: "nodes" as const,
            label: m.security_summary_level({ level: levelLabel(top) }),
            alert: true,
          },
        ]
      : []),
  ];
  return (
    <nav
      aria-label={m.security_summary_label()}
      className="mr-auto flex min-w-0 flex-wrap items-center gap-1.5 animate-enter"
      data-testid="security-summary"
    >
      {parts.map((part) => (
        <Badge
          key={part.key}
          variant={part.alert ? "destructive" : "outline"}
          className="h-6 cursor-pointer px-2.5 hover:bg-wash"
          render={
            <button
              type="button"
              onClick={() =>
                document.getElementById(CARD_IDS[part.key])?.scrollIntoView({
                  behavior: reducedMotion ? "auto" : "smooth",
                  block: "start",
                })
              }
            />
          }
          data-testid={`security-summary-${part.key}`}
        >
          {part.label}
        </Badge>
      ))}
    </nav>
  );
}

function UnderAttackCard({ siteId, protection }: { siteId: string; protection: SiteProtection }) {
  const { apply, save, pending } = useUpdateProtection(siteId);
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
    <Card id={CARD_IDS.underAttack} className="scroll-mt-4 animate-enter">
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
            onConfirm={() => apply({ underAttack: turningOn })}
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

/** The challenge page texts in the card's order: title and hint, Chinese then English. */
const CHALLENGE_TEXT_FIELDS: readonly [keyof ChallengeText, () => string][] = [
  ["titleZh", m.protection_challenge_title_zh],
  ["hintZh", m.protection_challenge_hint_zh],
  ["titleEn", m.protection_challenge_title_en],
  ["hintEn", m.protection_challenge_hint_en],
];

function ChallengeSettingsCard({
  siteId,
  protection,
}: {
  siteId: string;
  protection: SiteProtection;
}) {
  const { save, error, pending } = useUpdateProtection(siteId);
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  // Crawlers, texts and failure bans wait for challenge-v2 (what is set stays editable).
  const v2 = features.data?.challengeV2;
  const v2Locked = v2?.available === false;
  // Its own fields only: saving Under Attack or the CC policy leaves an unsaved draft here alone.
  const { draft, setDraft, dirty } = useDraft({
    passTtlSeconds: String(protection.passTtlSeconds),
    powDifficulty: String(protection.powDifficulty),
    powHighDifficulty: String(protection.powHighDifficulty),
    logJa4: protection.logJa4,
    allowVerifiedBots: protection.allowVerifiedBots,
    challengeText: protection.challengeText,
    failureBan: {
      enabled: protection.failureBan.enabled,
      threshold: String(protection.failureBan.threshold),
      banSeconds: String(protection.failureBan.banSeconds),
    },
  });
  const preset = usePreset(
    CHALLENGE_PRESETS,
    {
      passTtlSeconds: Number(draft.passTtlSeconds),
      powDifficulty: Number(draft.powDifficulty),
      powHighDifficulty: Number(draft.powHighDifficulty),
    },
    (values) =>
      setDraft({
        ...draft,
        passTtlSeconds: String(values.passTtlSeconds),
        powDifficulty: String(values.powDifficulty),
        powHighDifficulty: String(values.powHighDifficulty),
      }),
  );
  const failure = draft.failureBan;
  const textsSet = Object.values(protection.challengeText).some((text) => text !== "");
  return (
    <Card
      id={CARD_IDS.challenges}
      className="scroll-mt-4 animate-enter"
      style={{ animationDelay: "60ms" }}
    >
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            passTtlSeconds: Number(draft.passTtlSeconds),
            powDifficulty: Number(draft.powDifficulty),
            powHighDifficulty: Number(draft.powHighDifficulty),
            logJa4: draft.logJa4,
            allowVerifiedBots: draft.allowVerifiedBots,
            challengeText: draft.challengeText,
            failureBan: {
              enabled: failure.enabled,
              threshold: Number(failure.threshold),
              banSeconds: Number(failure.banSeconds),
            },
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.protection_challenge_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {v2Locked ? (
            <SafetyNote
              className="animate-in fade-in"
              data-testid="protection-challenge-v2-unavailable"
              data-reason={v2?.reason ?? undefined}
            >
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <PresetSelect id="protection-preset" value={preset.choice} onChange={preset.choose} />
            {preset.choice === "custom" ? (
              <>
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
              </>
            ) : null}
            <SwitchField
              id="protection-log-ja4"
              label={m.protection_log_ja4()}
              checked={draft.logJa4}
              testId="protection-log-ja4"
              onCheckedChange={(logJa4) => setDraft({ ...draft, logJa4 })}
            />
            <SwitchField
              id="protection-verified-bots"
              label={m.protection_allow_verified_bots()}
              checked={draft.allowVerifiedBots}
              disabled={v2Locked && !protection.allowVerifiedBots}
              testId="protection-verified-bots"
              onCheckedChange={(allowVerifiedBots) => setDraft({ ...draft, allowVerifiedBots })}
            />
          </div>
          <FieldSet className="min-w-0 gap-3" data-testid="protection-failure-ban">
            <SwitchField
              id="protection-failure-ban"
              label={m.protection_failure_ban()}
              checked={failure.enabled}
              disabled={v2Locked && !protection.failureBan.enabled}
              testId="protection-failure-ban-enabled"
              className="self-start"
              onCheckedChange={(enabled) =>
                setDraft({
                  ...draft,
                  // Turned on, it starts from the defaults when the fields hold no valid values.
                  failureBan: {
                    enabled,
                    threshold:
                      enabled && !(Number(failure.threshold) >= FAILURE_THRESHOLD_RANGE.min)
                        ? String(FAILURE_BAN_DEFAULTS.threshold)
                        : failure.threshold,
                    banSeconds:
                      enabled && !(Number(failure.banSeconds) >= FAILURE_BAN_SECONDS_RANGE.min)
                        ? String(FAILURE_BAN_DEFAULTS.banSeconds)
                        : failure.banSeconds,
                  },
                })
              }
            />
            {failure.enabled ? (
              <div className="grid gap-4 animate-in fade-in sm:grid-cols-2 lg:grid-cols-3">
                <NumberField
                  id="protection-failure-threshold"
                  label={m.protection_failure_threshold()}
                  value={failure.threshold}
                  min={FAILURE_THRESHOLD_RANGE.min}
                  max={FAILURE_THRESHOLD_RANGE.max}
                  step={1}
                  required
                  testId="protection-failure-threshold"
                  onChange={(threshold) =>
                    setDraft({ ...draft, failureBan: { ...failure, threshold } })
                  }
                />
                <NumberField
                  id="protection-failure-ban-seconds"
                  label={m.protection_failure_ban_seconds()}
                  value={failure.banSeconds}
                  min={FAILURE_BAN_SECONDS_RANGE.min}
                  max={FAILURE_BAN_SECONDS_RANGE.max}
                  step={1}
                  required
                  testId="protection-failure-ban-seconds"
                  onChange={(banSeconds) =>
                    setDraft({ ...draft, failureBan: { ...failure, banSeconds } })
                  }
                />
              </div>
            ) : null}
          </FieldSet>
          <FieldSet className="min-w-0 gap-0" data-testid="protection-challenge-text">
            <FieldLegend variant="label" className="mb-3 text-muted-foreground">
              {m.protection_challenge_text()}
            </FieldLegend>
            <div className="grid gap-4 sm:grid-cols-2">
              {CHALLENGE_TEXT_FIELDS.map(([key, label]) => (
                <Field key={key} data-disabled={(v2Locked && !textsSet) || undefined}>
                  <FieldLabel htmlFor={`protection-text-${key}`}>{label()}</FieldLabel>
                  <Input
                    id={`protection-text-${key}`}
                    value={draft.challengeText[key]}
                    maxLength={CHALLENGE_TEXT_MAX}
                    placeholder={m.protection_challenge_text_default()}
                    disabled={v2Locked && !textsSet}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        challengeText: { ...draft.challengeText, [key]: event.target.value },
                      })
                    }
                    data-testid={`protection-text-${key}`}
                  />
                </Field>
              ))}
            </div>
          </FieldSet>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="protection-save" />
      </form>
    </Card>
  );
}

function CcPolicyCard({ siteId, protection }: { siteId: string; protection: SiteProtection }) {
  const { save, error, pending } = useUpdateProtection(siteId);
  const { draft, setDraft, dirty } = useDraft({
    enabled: protection.cc.enabled,
    followTemplate: protection.cc.followTemplate,
    thresholds: toCcDraft(protection.cc),
  });
  // While following, the fields show the platform template.
  const shown: CcDraft = draft.followTemplate ? toCcDraft(protection.ccTemplate) : draft.thresholds;
  return (
    <Card
      id={CARD_IDS.cc}
      className="scroll-mt-4 animate-enter"
      style={{ animationDelay: "120ms" }}
    >
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
        <SaveBar dirty={dirty} pending={pending} error={error} testId="cc-save" />
      </form>
    </Card>
  );
}

/** The site's OWASP CRS: mode, paranoia level, threshold, exclusions and body limit. */
function WafCard({ siteId }: { siteId: string }) {
  const waf = useQuery(orpc.waf.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Card
      id={CARD_IDS.waf}
      className="scroll-mt-4 animate-enter"
      style={{ animationDelay: "150ms" }}
      data-testid="waf-card"
    >
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
      <QueryView query={combineQueries(waf, features)} frame={CardContent}>
        {([saved, available]) => (
          <WafForm
            key={saved.updatedAt ?? "default"}
            siteId={siteId}
            waf={saved}
            availability={available.crs}
            wafV2={available.wafV2}
          />
        )}
      </QueryView>
    </Card>
  );
}

function WafForm({
  siteId,
  waf,
  availability,
  wafV2,
}: {
  siteId: string;
  waf: SiteWaf;
  availability: FeatureAvailability;
  /** Exclusions by path or target (waf-v2). */
  wafV2: FeatureAvailability;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.waf.update.mutationOptions());
  const initial = {
    mode: waf.mode,
    paranoiaLevel: String(waf.paranoiaLevel),
    anomalyThreshold: String(waf.anomalyThreshold),
    requestBodyLimit: String(waf.requestBodyLimit),
    exclusions: waf.exclusions,
  };
  const [draft, setDraft] = React.useState(initial);
  const preset = usePreset(
    WAF_PRESETS,
    {
      paranoiaLevel: Number(draft.paranoiaLevel),
      anomalyThreshold: Number(draft.anomalyThreshold),
      requestBodyLimit: Number(draft.requestBodyLimit),
    },
    (values) =>
      setDraft({
        ...draft,
        paranoiaLevel: String(values.paranoiaLevel),
        anomalyThreshold: String(values.anomalyThreshold),
        requestBodyLimit: String(values.requestBodyLimit),
      }),
  );
  const [ruleInput, setRuleInput] = React.useState("");
  const [ruleError, setRuleError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Turning CRS on needs the feature; a site that runs it can still be turned off.
  const locked = !availability.available && waf.mode === "off";
  // The rules every path skips: the site-wide entry, edited as chips.
  const siteWide = siteWideRuleIds(draft.exclusions);
  const addRules = () => {
    const ids = parseRuleIds(ruleInput);
    const next = ids ? [...new Set([...siteWide, ...ids])] : null;
    if (!next || !wafExcludedRuleIds.safeParse(next).success) {
      setRuleError(m.waf_exclusions_invalid({ max: WAF_MAX_EXCLUSIONS }));
      return;
    }
    // Setup and evaluation rules would turn blocking off: the server refuses them too.
    const refused = unexcludable(ids ?? []);
    if (refused.length) {
      setRuleError(m.error_waf_rule_not_excludable({ ids: refused.join(", ") }));
      return;
    }
    setRuleError(null);
    setRuleInput("");
    setDraft({ ...draft, exclusions: withSiteWideRuleIds(draft.exclusions, next) });
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
            exclusions: draft.exclusions,
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
          <PresetSelect id="waf-preset" value={preset.choice} onChange={preset.choose} />
          {preset.choice === "custom" ? (
            <>
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
            </>
          ) : null}
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
          {siteWide.length ? (
            <ul className="flex flex-wrap gap-1.5" data-testid="waf-exclusions">
              {siteWide.map((id) => (
                <li key={id} className="animate-in fade-in">
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
                          exclusions: withSiteWideRuleIds(
                            draft.exclusions,
                            siteWide.filter((rule) => rule !== id),
                          ),
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
        <ExclusionEntries
          exclusions={draft.exclusions}
          wafV2={wafV2}
          onChange={(exclusions) => setDraft({ ...draft, exclusions })}
        />
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

/** Where an exclusion applies: its path and match, or the whole site. */
function exclusionScope(entry: Exclusion): string {
  return entry.path === "" ? m.waf_exclusion_whole_site() : entry.path;
}

/**
 * The exclusions besides the site-wide rule ids: by path (prefix or exact) and by target, each
 * edited in a dialog. Without waf-v2 on the cluster's nodes, new ones wait (the line says so);
 * saved ones can still be edited or removed.
 */
function ExclusionEntries({
  exclusions,
  wafV2,
  onChange,
}: {
  exclusions: Exclusion[];
  wafV2: FeatureAvailability;
  onChange: (exclusions: Exclusion[]) => void;
}) {
  // The site-wide entry's ids are the chips above; every other entry is a row here.
  const chips = exclusions.findIndex(isSiteWide);
  const rows = exclusions.flatMap((entry, index) => (index === chips ? [] : [{ entry, index }]));
  // Which entry the dialog edits (null: a new one).
  const dialog = useDialogState<number | null>();
  const full = exclusions.length >= WAF_MAX_EXCLUSION_ENTRIES;
  const editing = dialog.value === undefined || dialog.value === null ? null : dialog.value;
  return (
    <FieldSet className="min-w-0 gap-2" data-testid="waf-exclusion-entries">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLegend variant="label" className="mb-0">
          {m.waf_exclusion_entries()}
        </FieldLegend>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!wafV2.available || full}
          onClick={() => dialog.show(null)}
          data-testid="waf-exclusion-entry-add"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.waf_exclusion_add()}
        </Button>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-border/70 rounded-2xl sunk-well">
          {rows.map(({ entry, index }, i) => (
            <li
              key={`${index}-${entry.path}`}
              className="flex min-w-0 items-start gap-3 px-3 py-2.5 animate-enter"
              style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
              data-testid="waf-exclusion-entry"
              data-path={entry.path}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span
                    className={
                      entry.path === ""
                        ? "text-sm font-medium"
                        : "min-w-0 font-mono text-sm break-all"
                    }
                    data-testid="waf-exclusion-entry-path"
                  >
                    {exclusionScope(entry)}
                  </span>
                  {entry.path === "" ? null : (
                    <Badge variant="outline" data-testid="waf-exclusion-entry-match">
                      {entry.exact ? m.waf_exclusion_exact() : m.waf_exclusion_prefix()}
                    </Badge>
                  )}
                </div>
                <span
                  className="font-mono text-xs break-all text-muted-foreground tabular-nums"
                  data-testid="waf-exclusion-entry-rules"
                >
                  {entry.ruleIds.join(" ")}
                </span>
                {entry.targets.length ? (
                  <span
                    className="font-mono text-xs break-all text-muted-foreground"
                    data-testid="waf-exclusion-entry-targets"
                  >
                    {entry.targets.join(" ")}
                  </span>
                ) : null}
              </div>
              <div className="-my-1 flex shrink-0 items-center">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.waf_exclusion_edit()}
                  onClick={() => dialog.show(index)}
                  data-testid="waf-exclusion-entry-edit"
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.waf_exclusion_remove({ path: exclusionScope(entry) })}
                  onClick={() => onChange(exclusions.filter((_, at) => at !== index))}
                  data-testid="waf-exclusion-entry-remove"
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {wafV2.available ? null : (
        <SafetyNote
          className="animate-in fade-in"
          data-testid="waf-exclusion-entries-unavailable"
          data-reason={wafV2.reason ?? undefined}
        >
          {m.feature_unavailable_nodes()}
        </SafetyNote>
      )}
      {dialog.value !== undefined ? (
        <ExclusionDialog
          key={dialog.key}
          open={dialog.open}
          onOpenChange={dialog.onOpenChange}
          title={editing === null ? m.waf_exclusion_add() : m.waf_exclusion_edit()}
          submitLabel={m.common_confirm()}
          initial={
            (editing === null ? undefined : exclusions[editing]) ?? {
              path: "",
              exact: false,
              ruleIds: [],
              targets: [],
            }
          }
          blocked={
            // A saved entry by path stays editable; new ones wait for waf-v2.
            !wafV2.available && (editing === null || !needsWafV2(exclusions[editing] as Exclusion))
          }
          onSubmit={async (entry) => {
            onChange(
              editing === null
                ? [...exclusions, entry]
                : exclusions.map((existing, at) => (at === editing ? entry : existing)),
            );
            dialog.onOpenChange(false);
          }}
        />
      ) : null}
    </FieldSet>
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
        <QueryView query={rules}>
          {({ items }) => (
            <TopList
              title={m.waf_top_rules()}
              items={items.map((item) => ({ value: String(item.ruleId), count: item.requests }))}
              testId="waf-top-rules"
              mono
              actions={(value) =>
                crsDetectionRule(Number(value))
                  ? [
                      {
                        label: m.quick_exclude_rule({ id: value }),
                        action: { kind: "exclude-rule", siteId, ruleId: Number(value) },
                        testId: "waf-top-exclude-rule",
                      },
                      {
                        label: m.quick_exclude_path(),
                        action: { kind: "exclude-path", siteId, ruleIds: [Number(value)] },
                        testId: "waf-top-exclude-path",
                      },
                    ]
                  : []
              }
            />
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Requests that matched rules with the log action, per rule, over a range (approximate). */
function LoggedRulesCard({ siteId }: { siteId: string }) {
  const [range, setRange] = React.useState<AnalyticsRange>("24h");
  const logged = useQuery({
    ...orpc.rules.topLogged.queryOptions({ input: { id: siteId, range, limit: 10 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "285ms" }}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.rules_logged_title()}</CardTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="logged-rules-range"
            label={m.security_hours()}
            value={range}
            testId="logged-rules-range"
            options={ANALYTICS_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
            onChange={(value) => setRange(value as AnalyticsRange)}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={logged}>
          {({ items, unsupportedNodes }) => (
            <>
              <TopList
                title={m.rules_logged_rule()}
                items={items.map((item) => ({
                  id: item.ruleId,
                  value:
                    item.name === null
                      ? m.rules_logged_deleted()
                      : item.platform
                        ? m.rules_logged_platform({ name: item.name })
                        : item.name,
                  count: item.requests,
                }))}
                testId="logged-rules"
              />
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="logged-rules-partial">
                  {m.rules_logged_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Requests the site's access authentication refused over a range. */
function AuthFailuresCard({ siteId }: { siteId: string }) {
  const [range, setRange] = React.useState<AnalyticsRange>("24h");
  const failures = useQuery({
    ...orpc.authRules.failures.queryOptions({ input: { id: siteId, range } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "300ms" }}
      data-testid="auth-failures-card"
    >
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.auth_failures_title()}</CardTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="auth-failures-range"
            label={m.security_hours()}
            value={range}
            testId="auth-failures-range"
            options={ANALYTICS_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
            onChange={(value) => setRange(value as AnalyticsRange)}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={failures}>
          {({ requests, unsupportedNodes }) => (
            <>
              <p
                className="font-heading text-3xl font-medium tabular-nums"
                data-testid="auth-failures-count"
              >
                {formatNumber(requests)}
              </p>
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="auth-failures-partial">
                  {m.auth_failures_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** The site's statistics dimensions over a range of its own (block reasons, challenges). */
function useDimensions(siteId: string, range: AnalyticsRange) {
  return useQuery({
    ...orpc.analytics.dimensions.queryOptions({ input: { range, siteId } }),
    placeholderData: keepPreviousData,
  });
}

/** A card's title with the range select of its own. */
function RangeHeader({
  title,
  range,
  onRangeChange,
  id,
}: {
  title: string;
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
  id: string;
}) {
  return (
    <CardHeader className="flex flex-wrap items-center justify-between gap-3">
      <CardTitle>{title}</CardTitle>
      <div className="w-full sm:w-44">
        <FormSelect
          id={id}
          label={m.security_hours()}
          value={range}
          testId={id}
          options={ANALYTICS_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
          onChange={(value) => onRangeChange(value as AnalyticsRange)}
        />
      </div>
    </CardHeader>
  );
}

/** Requests the nodes refused or challenged over a range, by reason. */
function BlockReasonsCard({ siteId }: { siteId: string }) {
  const [range, setRange] = React.useState<AnalyticsRange>("24h");
  const dimensions = useDimensions(siteId, range);
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "315ms" }}
      data-testid="block-reasons-card"
    >
      <RangeHeader
        title={m.block_reasons_title()}
        range={range}
        onRangeChange={setRange}
        id="block-reasons-range"
      />
      <CardContent className="flex flex-col gap-4">
        <QueryView query={dimensions}>
          {({ blockReasons, unsupportedNodes }) => (
            <>
              <TopList
                title={m.block_reasons_reason()}
                items={[...blockReasons]
                  .filter((item) => item.requests > 0)
                  .sort((a, b) => b.requests - a.requests)
                  .map((item) => ({
                    id: item.key,
                    value: blockReasonLabel(item.key),
                    count: item.requests,
                  }))}
                testId="block-reasons"
              />
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="block-reasons-partial">
                  {m.stats_dims_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Challenges issued and passed over a range, and the share that passed. */
function ChallengesCard({ siteId }: { siteId: string }) {
  const [range, setRange] = React.useState<AnalyticsRange>("24h");
  const dimensions = useDimensions(siteId, range);
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "330ms" }}
      data-testid="challenges-card"
    >
      <RangeHeader
        title={m.challenges_title()}
        range={range}
        onRangeChange={setRange}
        id="challenges-range"
      />
      <CardContent className="flex flex-col gap-4">
        <QueryView query={dimensions}>
          {({ challenges, unsupportedNodes }) => (
            <>
              {challenges.issued === 0 && challenges.passed === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="challenges-empty">
                  {m.security_top_empty()}
                </p>
              ) : (
                <dl className="grid grid-cols-3 gap-4 sm:max-w-xl">
                  {(
                    [
                      // A pass can be counted by another node than the challenge (or fall in
                      // the next range): the rate stops at 100%, and needs issued challenges.
                      ...(challenges.issued > 0
                        ? ([
                            [
                              "rate",
                              m.challenges_rate(),
                              formatPercent(
                                Math.min(100, (challenges.passed / challenges.issued) * 100),
                              ),
                            ],
                          ] as const)
                        : []),
                      ["issued", m.challenges_issued(), formatNumber(challenges.issued)],
                      ["passed", m.challenges_passed(), formatNumber(challenges.passed)],
                    ] as const
                  ).map(([key, label, value]) => (
                    <div key={key} className="flex min-w-0 flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd
                        className={cn(
                          "font-heading font-medium tabular-nums",
                          key === "rate" ? "text-3xl" : "text-xl",
                        )}
                        data-testid={`challenges-${key}`}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="challenges-partial">{m.stats_dims_partial()}</SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
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
    <Card
      id={CARD_IDS.nodes}
      className="scroll-mt-4 animate-enter"
      style={{ animationDelay: "180ms" }}
    >
      <CardHeader>
        <CardTitle>{m.security_nodes_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryView
          query={state}
          isEmpty={(data) => data.nodes.length === 0}
          empty={<EmptyState title={m.security_no_nodes()} />}
        >
          {({ nodes }) => (
            <ul className="divide-y rounded-2xl sunk-well" data-testid="security-nodes">
              {nodes.map((node, index) => (
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
        </QueryView>
      </CardContent>
    </Card>
  );
}

function TopList({
  title,
  items,
  testId,
  mono,
  actions,
}: {
  title: string;
  /** `id` keys an entry whose value may repeat (e.g. rule names). */
  items: { id?: string; value: string; count: number }[];
  testId: string;
  mono?: boolean;
  /** The row menu of an entry. */
  actions?: (value: string) => RowMenuItem[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.security_top_empty()}</p>
      ) : (
        <ol className="divide-y rounded-2xl sunk-well">
          {items.map((item) => (
            <li key={item.id ?? item.value} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-xs" : ""}`}>
                {item.value}
              </span>
              <span className="tabular-nums text-muted-foreground">{formatNumber(item.count)}</span>
              {actions ? <TopListActions items={actions(item.value)} /> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** An entry's menu, or the menu's room so the counts of a list stay aligned. */
function TopListActions({ items }: { items: RowMenuItem[] }) {
  return items.length ? <RowMenu items={items} /> : <span aria-hidden className="w-6 shrink-0" />;
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
        <QueryView query={state}>
          {({ topIps, topPaths }) => (
            <div className="grid gap-4 md:grid-cols-2">
              <TopList
                title={m.security_top_ips()}
                items={topIps}
                testId="security-top-ips"
                mono
                actions={(address) => [
                  { label: m.quick_ban_ip(), action: { kind: "ban", address, siteId } },
                ]}
              />
              <TopList
                title={m.security_top_paths()}
                items={topPaths}
                testId="security-top-paths"
                mono
                actions={(path) => [
                  {
                    label: m.quick_purge_url(),
                    action: { kind: "purge", targets: [path], siteId },
                  },
                ]}
              />
            </div>
          )}
        </QueryView>
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
        <QueryView
          query={events}
          isEmpty={(data) => data.items.length === 0}
          empty={<EmptyState title={m.security_events_empty()} />}
        >
          {({ items, total }) => (
            <>
              <ol
                className="flex flex-col divide-y rounded-2xl sunk-well"
                data-testid="security-events"
              >
                {items.map((event, index) => (
                  <li
                    key={event.id}
                    className="flex flex-col gap-1 px-3 py-2.5 animate-enter"
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
                      {event.kind === "ip_banned" && event.address ? (
                        <RowMenu
                          items={[
                            {
                              label: m.quick_ban_everywhere(),
                              action: { kind: "ban", address: event.address, scope: "platform" },
                              testId: "event-ban-everywhere",
                            },
                            {
                              label: m.bans_unban(),
                              action: { kind: "unban", address: event.address, siteId },
                              testId: "event-unban",
                            },
                          ]}
                        />
                      ) : null}
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
              <Pager page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}
