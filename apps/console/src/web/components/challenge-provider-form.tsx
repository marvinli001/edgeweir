import {
  ALIYUN_REGIONS,
  CHALLENGE_PROVIDER_KINDS,
  CHALLENGE_PROVIDER_SECRETS,
  type ChallengeProvider,
  type ChallengeProviderInput,
  type ChallengeProviderKind,
  MIN_SCORE_DEFAULT,
  MIN_SCORE_RANGE,
} from "@edgeweir/contract";
import { Badge } from "@/components/arc/badge/badge";
import { Input } from "@/components/arc/input/input";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel } from "@/components/layout/form";
import { NumberField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
import { providerKindLabel } from "@/lib/protection";

type Region = (typeof ALIYUN_REGIONS)[number];

/** An interactive provider being edited: numbers stay text, secrets start empty (write-only). */
export interface ProviderDraft {
  kind: ChallengeProviderKind;
  siteKey: string;
  minScore: string;
  projectId: string;
  region: Region;
  prefix: string;
  secret: Record<string, string>;
}

export const toProviderDraft = (p: ChallengeProvider): ProviderDraft => ({
  kind: p.kind,
  siteKey: p.siteKey,
  minScore: String(p.minScore || MIN_SCORE_DEFAULT),
  projectId: p.projectId,
  region: p.region,
  prefix: p.prefix,
  secret: {},
});

const hasScore = (kind: ChallengeProviderKind) =>
  kind === "recaptcha_v3" || kind === "recaptcha_enterprise";

/** What saving the draft sends: the kind's own fields (others empty), and only the secrets typed. */
export function fromProviderDraft(
  d: ProviderDraft,
): ChallengeProviderInput & { siteKey: string; projectId: string; prefix: string } {
  const empty = { siteKey: "", projectId: "", prefix: "" };
  if (d.kind === "builtin") return { kind: "builtin", ...empty };
  const secret = Object.fromEntries(
    CHALLENGE_PROVIDER_SECRETS[d.kind]
      .map((key) => [key, d.secret[key]?.trim() ?? ""] as const)
      .filter(([, value]) => value !== ""),
  );
  return {
    ...empty,
    kind: d.kind,
    siteKey: d.siteKey.trim(),
    ...(hasScore(d.kind) ? { minScore: Number(d.minScore) } : {}),
    ...(d.kind === "recaptcha_enterprise" ? { projectId: d.projectId.trim() } : {}),
    ...(d.kind === "aliyun" ? { region: d.region, prefix: d.prefix.trim() } : {}),
    ...(Object.keys(secret).length ? { secret } : {}),
  };
}

/** The saved secrets still apply: same kind, every secret field saved. */
const secretsKept = (d: ProviderDraft, saved: ChallengeProvider) =>
  saved.kind === d.kind && saved.secretSet;

const SECRET_LABELS: Record<string, () => string> = {
  secret: m.challenge_provider_secret,
  apiKey: m.challenge_provider_api_key,
  secretId: m.challenge_provider_secret_id,
  secretKey: m.challenge_provider_secret_key,
  appSecretKey: m.challenge_provider_app_secret_key,
  accessKeyId: m.challenge_provider_access_key_id,
  accessKeySecret: m.challenge_provider_access_key_secret,
  captchaKey: m.challenge_provider_captcha_key,
};

/** Why the draft cannot be saved: a new kind (or one without saved secrets) needs all of them. */
export function providerDraftIssue(d: ProviderDraft, saved: ChallengeProvider): string | null {
  if (d.kind === "builtin" || secretsKept(d, saved)) return null;
  const missing = CHALLENGE_PROVIDER_SECRETS[d.kind].filter((key) => !d.secret[key]?.trim());
  return missing.length
    ? m.error_challenge_provider_secret_required({
        fields: missing.map((key) => SECRET_LABELS[key]?.() ?? key).join(", "),
      })
    : null;
}

const siteKeyLabel = (kind: ChallengeProviderKind) =>
  kind === "tencent"
    ? m.challenge_provider_captcha_app_id()
    : kind === "aliyun"
      ? m.challenge_provider_scene_id()
      : kind === "geetest"
        ? m.challenge_provider_captcha_id()
        : m.challenge_provider_site_key();

const REGION_LABELS: Record<Region, () => string> = {
  cn: m.challenge_provider_region_cn,
  sgp: m.challenge_provider_region_sgp,
};

/**
 * The fields of an interactive provider: the kind, its public key and options, and its secrets
 * (password inputs, never prefilled; saved ones show a badge and stay when left empty).
 */
export function ChallengeProviderFields({
  id,
  draft,
  saved,
  disabled,
  onChange,
}: {
  /** Prefix of the field ids and test ids. */
  id: string;
  draft: ProviderDraft;
  saved: ChallengeProvider;
  disabled?: boolean;
  onChange: (draft: ProviderDraft) => void;
}) {
  const set = (change: Partial<ProviderDraft>) => onChange({ ...draft, ...change });
  const kept = secretsKept(draft, saved);
  const kind = draft.kind;
  return (
    <>
      <FormSelect
        id={`${id}-kind`}
        label={m.challenge_provider_kind()}
        value={kind}
        disabled={disabled}
        testId={`${id}-kind`}
        options={CHALLENGE_PROVIDER_KINDS.map((value) => ({
          value,
          label: providerKindLabel(value),
        }))}
        // Secrets belong to one kind: switching drops what was typed.
        onChange={(next) => set({ kind: next, secret: {} })}
      />
      {kind === "builtin" ? null : (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-site-key`}>{siteKeyLabel(kind)}</FieldLabel>
            <Input
              id={`${id}-site-key`}
              value={draft.siteKey}
              required
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className="font-mono"
              onChange={(event) => set({ siteKey: event.target.value })}
              data-testid={`${id}-site-key`}
            />
          </Field>
          {kind === "recaptcha_enterprise" ? (
            <Field>
              <FieldLabel htmlFor={`${id}-project`}>{m.challenge_provider_project_id()}</FieldLabel>
              <Input
                id={`${id}-project`}
                value={draft.projectId}
                required
                maxLength={30}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                className="font-mono"
                onChange={(event) => set({ projectId: event.target.value })}
                data-testid={`${id}-project`}
              />
            </Field>
          ) : null}
          {hasScore(kind) ? (
            <NumberField
              id={`${id}-min-score`}
              label={m.challenge_provider_min_score()}
              value={draft.minScore}
              min={MIN_SCORE_RANGE.min}
              max={MIN_SCORE_RANGE.max}
              step={1}
              required
              disabled={disabled}
              testId={`${id}-min-score`}
              onChange={(minScore) => set({ minScore })}
            />
          ) : null}
          {kind === "aliyun" ? (
            <>
              <FormSelect
                id={`${id}-region`}
                label={m.challenge_provider_region()}
                value={draft.region}
                disabled={disabled}
                testId={`${id}-region`}
                options={ALIYUN_REGIONS.map((value) => ({
                  value,
                  label: REGION_LABELS[value](),
                }))}
                onChange={(region) => set({ region })}
              />
              <Field>
                <FieldLabel htmlFor={`${id}-prefix`}>{m.challenge_provider_prefix()}</FieldLabel>
                <Input
                  id={`${id}-prefix`}
                  value={draft.prefix}
                  required
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  className="font-mono"
                  onChange={(event) => set({ prefix: event.target.value })}
                  data-testid={`${id}-prefix`}
                />
              </Field>
            </>
          ) : null}
          {CHALLENGE_PROVIDER_SECRETS[kind].map((key) => (
            <Field key={key}>
              <FieldLabel htmlFor={`${id}-secret-${key}`}>
                {SECRET_LABELS[key]?.() ?? key}
                {kept ? (
                  <Badge size="sm" tone="success" data-testid={`${id}-secret-${key}-saved`}>
                    {m.common_saved()}
                  </Badge>
                ) : null}
              </FieldLabel>
              <Input
                id={`${id}-secret-${key}`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                maxLength={512}
                required={!kept}
                disabled={disabled}
                value={draft.secret[key] ?? ""}
                placeholder={kept ? m.site_secret_saved() : undefined}
                onChange={(event) =>
                  set({ secret: { ...draft.secret, [key]: event.target.value } })
                }
                data-testid={`${id}-secret-${key}`}
              />
            </Field>
          ))}
        </>
      )}
    </>
  );
}
