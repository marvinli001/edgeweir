import {
  type CcThresholds,
  CHALLENGE_TYPES,
  type ChallengeType,
  EVENT_RETENTION_RANGE,
  type ProtectionSettings,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { CcThresholdFields, fromCcDraft, toCcDraft } from "@/components/cc-thresholds";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { challengeLabel } from "@/lib/protection";

/** Admin protection section: platform Under Attack, event retention and the CC template. */
export function ProtectionSettingsCards() {
  const settings = useQuery(orpc.settings.protection.queryOptions());
  const template = useQuery(orpc.settings.ccTemplate.queryOptions());
  return (
    <>
      <Card className="animate-enter" style={{ animationDelay: "160ms" }}>
        <CardHeader>
          <CardTitle>{m.protection_settings_title()}</CardTitle>
        </CardHeader>
        {settings.isPending ? (
          <CardContent>
            <LoadingState />
          </CardContent>
        ) : settings.isError ? (
          <CardContent>
            <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
          </CardContent>
        ) : (
          <ProtectionForm key={JSON.stringify(settings.data)} initial={settings.data} />
        )}
      </Card>
      <Card className="animate-enter" style={{ animationDelay: "180ms" }}>
        <CardHeader>
          <CardTitle>{m.cc_template_title()}</CardTitle>
        </CardHeader>
        {template.isPending ? (
          <CardContent>
            <LoadingState />
          </CardContent>
        ) : template.isError ? (
          <CardContent>
            <ErrorState error={template.error} onRetry={() => template.refetch()} />
          </CardContent>
        ) : (
          <CcTemplateForm key={JSON.stringify(template.data)} initial={template.data} />
        )}
      </Card>
    </>
  );
}

function ProtectionForm({ initial }: { initial: ProtectionSettings }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setProtection.mutationOptions());
  const [type, setType] = React.useState(initial.underAttackChallenge);
  const [retention, setRetention] = React.useState(String(initial.eventRetentionDays));
  const [error, setError] = React.useState<string | null>(null);
  const apply = async (next: ProtectionSettings) => {
    await save.mutateAsync(next);
    await queryClient.invalidateQueries({ queryKey: orpc.settings.protection.key() });
    toast.success(m.common_saved());
  };
  const submit = async (next: ProtectionSettings) => {
    setError(null);
    try {
      await apply(next);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const turningOn = !initial.underAttack;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({
          ...initial,
          underAttackChallenge: type,
          eventRetentionDays: Number(retention),
        });
      }}
    >
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field orientation="horizontal" className="min-h-9 w-auto self-end">
          <ConfirmDialog
            trigger={
              <Switch
                id="platform-under-attack"
                checked={initial.underAttack}
                disabled={save.isPending}
                data-testid="platform-under-attack"
              />
            }
            destructive={turningOn}
            title={
              turningOn ? m.protection_platform_on_confirm() : m.protection_platform_off_confirm()
            }
            note={m.protection_platform_note()}
            confirmLabel={turningOn ? m.protection_turn_on() : m.protection_turn_off()}
            onConfirm={() =>
              apply({ ...initial, underAttack: turningOn, underAttackChallenge: type })
            }
          />
          <FieldLabel htmlFor="platform-under-attack">
            {m.protection_platform_under_attack()}
          </FieldLabel>
          {initial.underAttack ? (
            <Badge variant="destructive" data-testid="platform-under-attack-on">
              {m.protection_on()}
            </Badge>
          ) : null}
        </Field>
        <FormSelect
          id="platform-under-attack-type"
          label={m.rules_challenge_type()}
          value={type}
          testId="platform-under-attack-type"
          options={CHALLENGE_TYPES.map((value) => ({ value, label: challengeLabel(value) }))}
          onChange={(value) => setType(value as ChallengeType)}
        />
        <NumberField
          id="protection-retention"
          label={m.protection_retention()}
          value={retention}
          onChange={setRetention}
          min={EVENT_RETENTION_RANGE.min}
          max={EVENT_RETENTION_RANGE.max}
          step={1}
          required
          testId="protection-retention"
        />
      </CardContent>
      <SaveBar
        dirty={
          type !== initial.underAttackChallenge || retention !== String(initial.eventRetentionDays)
        }
        pending={save.isPending}
        error={error}
        testId="protection-settings-save"
      />
    </form>
  );
}

function CcTemplateForm({ initial }: { initial: CcThresholds }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setCcTemplate.mutationOptions());
  const [draft, setDraft] = React.useState(() => toCcDraft(initial));
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await save.mutateAsync(fromCcDraft(draft));
          await queryClient.invalidateQueries({ queryKey: orpc.settings.ccTemplate.key() });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="flex flex-col gap-4">
        <CcThresholdFields prefix="cc-template" value={draft} onChange={setDraft} />
        <SafetyNote>{m.cc_per_node_note()}</SafetyNote>
      </CardContent>
      <SaveBar
        dirty={JSON.stringify(draft) !== JSON.stringify(toCcDraft(initial))}
        pending={save.isPending}
        error={error}
        testId="cc-template-save"
      />
    </form>
  );
}
