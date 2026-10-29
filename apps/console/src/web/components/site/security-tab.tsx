import {
  CC_LEVELS,
  CC_PRESETS,
  CHALLENGE_PRESETS,
  CHALLENGE_TEXT_MAX,
  CHALLENGE_TYPES,
  type ChallengeText,
  type ChallengeType,
  FAILURE_BAN_DEFAULTS,
  FAILURE_BAN_SECONDS_RANGE,
  FAILURE_THRESHOLD_RANGE,
  type FeatureAvailability,
  matchPreset,
  PASS_TTL_RANGE,
  POW_DIFFICULTY_RANGE,
  POW_HIGH_DIFFICULTY_RANGE,
  type SiteProtection,
  type SiteProtectionUpdateInput,
  type SiteWaf,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Switch } from "@/components/arc/switch/switch";
import {
  type CcDraft,
  CcThresholdFields,
  fromCcDraft,
  toCcDraft,
} from "@/components/cc-thresholds";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormSelect } from "@/components/form-select";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { LinkButton } from "@/components/link-button";
import { PresetSelect, presetLabel, usePreset } from "@/components/preset-select";
import { SafetyNote } from "@/components/safety-note";
import { ExclusionDialog } from "@/components/site/exclusion-dialog";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { useDialogState } from "@/hooks/use-dialog-state";
import { useDraft } from "@/hooks/use-draft";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { formatDateMinutes, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { challengeLabel, levelLabel, wafModeLabel } from "@/lib/protection";
import { toast } from "@/lib/toast";
import {
  type Exclusion,
  isSiteWide,
  needsWafV2,
  parseRuleIds,
  siteWideRuleIds,
  unexcludable,
  withSiteWideRuleIds,
} from "@/lib/waf-exclusions";

/** Saves part of the site's protection and refreshes it; returns whether it worked. */
function useUpdateProtection(siteId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.protection.update.mutationOptions());
  const [error, setError] = React.useState<string | null>(null);
  /** Saves or throws (for confirmations, which show the failure themselves). */
  const apply = async (patch: Omit<SiteProtectionUpdateInput, "id">) => {
    const saved = await mutation.mutateAsync({ id: siteId, ...patch });
    queryClient.setQueryData(orpc.protection.get.queryKey({ input: { id: siteId } }), saved);
    // Saving the switch hands an automatic mitigation's hold to the operator.
    if (patch.underAttack !== undefined)
      await queryClient.invalidateQueries({ queryKey: orpc.autoMitigation.key() });
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
          <LinkButton
            size="sm"
            variant="secondary"
            to="/bans"
            search={{ site: siteId }}
            data-testid="security-site-bans"
          >
            {m.security_site_bans()}
          </LinkButton>
          <LinkButton size="sm" variant="secondary" to="/rules">
            {m.rules_platform()}
          </LinkButton>
          <LinkButton size="sm" variant="secondary" to="/protection">
            {m.protection_page_title()}
          </LinkButton>
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
    </div>
  );
}

/** Where each part of the summary scrolls to. */
const CARD_IDS = {
  underAttack: "security-under-attack",
  challenges: "security-challenges",
  cc: "security-cc",
  waf: "security-waf",
} as const;

/**
 * One line of what is in effect: Under Attack, the CC policy, CRS, challenges and, when raised,
 * the nodes' level. Each part scrolls to its card; the nodes' level opens the attacks tab.
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
  const parts: { key: keyof typeof CARD_IDS | "nodes"; label: string; alert?: boolean }[] = [
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
      {parts.map((part) =>
        part.key === "nodes" ? (
          <Link
            key={part.key}
            to="/sites/$id"
            params={{ id: siteId }}
            search={{ tab: "attacks" }}
            className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            data-testid={`security-summary-${part.key}`}
          >
            <Badge size="sm" tone={part.alert ? "danger" : "neutral"} className="min-h-6 px-2.5">
              {part.label}
            </Badge>
          </Link>
        ) : (
          <button
            key={part.key}
            type="button"
            onClick={() =>
              document.getElementById(CARD_IDS[part.key as keyof typeof CARD_IDS])?.scrollIntoView({
                behavior: reducedMotion ? "auto" : "smooth",
                block: "start",
              })
            }
            className="cursor-pointer rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            data-testid={`security-summary-${part.key}`}
          >
            <Badge size="sm" tone={part.alert ? "danger" : "neutral"} className="min-h-6 px-2.5">
              {part.label}
            </Badge>
          </button>
        ),
      )}
    </nav>
  );
}

function UnderAttackCard({ siteId, protection }: { siteId: string; protection: SiteProtection }) {
  const { apply, save, pending } = useUpdateProtection(siteId);
  const mitigation = useQuery(
    orpc.autoMitigation.get.queryOptions({
      input: { id: siteId },
      refetchInterval: 30_000,
      meta: { background: true },
    }),
  );
  const automatic = protection.underAttack ? mitigation.data?.active : null;
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
    <Panel id={CARD_IDS.underAttack} className="scroll-mt-4 animate-enter">
      <PanelHeader>
        <PanelTitle>{m.protection_under_attack()}</PanelTitle>
      </PanelHeader>
      <PanelContent className="grid gap-4 sm:grid-cols-2">
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
            <Badge size="sm" tone="danger" data-testid="protection-under-attack-on">
              {m.protection_on()}
            </Badge>
          ) : null}
          {automatic ? (
            <Badge size="sm" tone="neutral" data-testid="protection-under-attack-auto">
              {m.protection_under_attack_auto({ time: formatDateMinutes(automatic.expiresAt) })}
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
      </PanelContent>
    </Panel>
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
    <Panel
      id={CARD_IDS.challenges}
      className="scroll-mt-4 animate-enter"
      style={{ animationDelay: "60ms" }}
    >
      <form
        className="flex flex-col gap-(--panel-pad)"
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
        <PanelHeader>
          <PanelTitle>{m.protection_challenge_title()}</PanelTitle>
        </PanelHeader>
        <PanelContent form className="flex flex-col gap-5">
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
        </PanelContent>
        <SaveBar indent dirty={dirty} pending={pending} error={error} testId="protection-save" />
      </form>
    </Panel>
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
    <Panel
      id={CARD_IDS.cc}
      className="scroll-mt-4 animate-enter"
      style={{ animationDelay: "120ms" }}
    >
      <form
        className="flex flex-col gap-(--panel-pad)"
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
        <PanelHeader>
          <PanelTitle>{m.cc_title()}</PanelTitle>
        </PanelHeader>
        <PanelContent form className="flex flex-col gap-4">
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
        </PanelContent>
        <SaveBar indent dirty={dirty} pending={pending} error={error} testId="cc-save" />
      </form>
    </Panel>
  );
}

/** The site's OWASP CRS: mode, paranoia level, threshold, exclusions and body limit. */
function WafCard({ siteId }: { siteId: string }) {
  const waf = useQuery(orpc.waf.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Panel
      id={CARD_IDS.waf}
      className="scroll-mt-4 animate-enter"
      style={{ animationDelay: "150ms" }}
      data-testid="waf-card"
    >
      <PanelHeader className="flex flex-wrap items-center gap-2">
        <PanelTitle>{m.waf_title()}</PanelTitle>
        {waf.data && waf.data.mode !== "off" ? (
          <Badge
            size="sm"
            tone={waf.data.mode === "block" ? "danger" : "neutral"}
            data-testid="waf-mode-badge"
          >
            {wafModeLabel(waf.data.mode)}
          </Badge>
        ) : null}
      </PanelHeader>
      <QueryView query={combineQueries(waf, features)} frame={PanelContent}>
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
    </Panel>
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
  const form = useSettingsForm({
    value: waf,
    toDraft: (value) => ({
      mode: value.mode,
      paranoiaLevel: String(value.paranoiaLevel),
      anomalyThreshold: String(value.anomalyThreshold),
      requestBodyLimit: String(value.requestBodyLimit),
      exclusions: value.exclusions,
    }),
    toInput: (draft) => ({
      id: siteId,
      mode: draft.mode,
      paranoiaLevel: Number(draft.paranoiaLevel),
      anomalyThreshold: Number(draft.anomalyThreshold),
      requestBodyLimit: Number(draft.requestBodyLimit),
      exclusions: draft.exclusions,
    }),
    mutation: orpc.waf.update.mutationOptions(),
    onSaved: (saved) =>
      queryClient.setQueryData(orpc.waf.get.queryKey({ input: { id: siteId } }), saved),
  });
  const { draft, setDraft } = form;
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
    <form className="flex flex-col gap-(--panel-pad)" onSubmit={form.submit}>
      <PanelContent form className="flex flex-col gap-4">
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
              variant="secondary"
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
                    size="sm"
                    tone="neutral"
                    className="gap-1 font-mono tabular-nums"
                    data-testid="waf-exclusion"
                    data-rule-id={id}
                  >
                    {id}
                    <button
                      type="button"
                      className="relative -mr-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5 pointer-coarse:after:content-['']"
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
      </PanelContent>
      <SaveBar
        indent
        dirty={form.dirty}
        pending={form.pending}
        error={form.error}
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
          variant="secondary"
          disabled={!wafV2.available || full}
          onClick={() => dialog.show(null)}
          data-testid="waf-exclusion-entry-add"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.waf_exclusion_add()}
        </Button>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-border/70 rounded-lg faint-well">
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
                    <Badge size="sm" tone="neutral" data-testid="waf-exclusion-entry-match">
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
                  className="icon-button"
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={m.waf_exclusion_edit()}
                  onClick={() => dialog.show(index)}
                  data-testid="waf-exclusion-entry-edit"
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                </Button>
                <Button
                  className="icon-button"
                  type="button"
                  size="sm"
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
