import {
  AUTO_MITIGATION_DURATION_RANGE,
  AUTO_MITIGATION_LEVELS,
  type AutoMitigation,
  type AutoMitigationLevel,
  type AutoMitigationSettings,
  CC_LEVELS,
  type SiteProtection,
} from "@edgeweir/contract";
import { Edit02Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect, type Option } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateMinutes, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { levelLabel } from "@/lib/protection";

const { min: MIN_MINUTES, max: MAX_MINUTES } = AUTO_MITIGATION_DURATION_RANGE;

const integerIn = (text: string, min: number, max: number) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
};

/** What an automatic mitigation changes: its own state, the site's Under Attack, its revision. */
const MITIGATION_VIEWS = [orpc.autoMitigation.key(), orpc.protection.key(), orpc.sites.key()];

/**
 * A site's automatic mitigation (autoMitigation.get, polled every 15 seconds): what it holds and
 * until when, with a button that ends it, the trigger level and hold, the level the nodes report
 * now, and a dialog that edits the settings.
 */
export function AutoMitigationCard({ siteId, siteName }: { siteId: string; siteName: string }) {
  const query = useQuery(
    orpc.autoMitigation.get.queryOptions({
      input: { id: siteId },
      refetchInterval: 15_000,
      meta: { background: true },
    }),
  );
  const protection = useQuery(orpc.protection.get.queryOptions({ input: { id: siteId } }));
  const [editing, setEditing] = React.useState(false);
  const data = query.data;
  return (
    <Card className="animate-enter" data-testid="auto-mitigation-card">
      <CardHeader>
        <CardTitle>{m.attacks_mitigation_title()}</CardTitle>
        {data?.settings ? (
          <CardAction>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.common_edit()}
              onClick={() => setEditing(true)}
              data-testid="auto-mitigation-edit"
            >
              <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <QueryView
        query={query}
        frame={CardContent}
        isEmpty={(value) => value.settings === null}
        empty={
          <CardContent>
            <EmptyState title={m.attacks_mitigation_empty()} icon={Shield01Icon} art="checkpoint">
              <Button onClick={() => setEditing(true)} data-testid="auto-mitigation-setup">
                {m.attacks_mitigation_setup()}
              </Button>
            </EmptyState>
          </CardContent>
        }
      >
        {(value) => (
          <MitigationBody
            siteId={siteId}
            siteName={siteName}
            mitigation={value}
            protection={protection.data}
          />
        )}
      </QueryView>
      {editing && data ? (
        <MitigationDialog open onOpenChange={setEditing} siteId={siteId} mitigation={data} />
      ) : null}
    </Card>
  );
}

function MitigationBody({
  siteId,
  siteName,
  mitigation,
  protection,
}: {
  siteId: string;
  siteName: string;
  mitigation: AutoMitigation;
  protection: SiteProtection | undefined;
}) {
  const end = useMutation({
    ...orpc.autoMitigation.restore.mutationOptions(),
    meta: { invalidates: MITIGATION_VIEWS, success: m.attacks_mitigation_ended },
  });
  const { settings, active, paused, level, lastError } = mitigation;
  if (!settings) return null;
  const cc = protection?.effectiveCc;
  // The site's CC policy decides whether the level can reach the trigger.
  const unreachable = !protection
    ? null
    : !cc
      ? m.attacks_mitigation_no_cc()
      : CC_LEVELS.indexOf(cc.maxLevel as (typeof CC_LEVELS)[number]) <
          CC_LEVELS.indexOf(settings.threshold)
        ? m.attacks_mitigation_unreachable({ max: levelLabel(cc.maxLevel) })
        : null;
  return (
    <CardContent className="flex flex-col gap-4">
      {active ? (
        <Alert variant="destructive" data-testid="auto-mitigation-active">
          <AlertTitle>
            {m.attacks_mitigation_active({ time: formatDateMinutes(active.expiresAt) })}
          </AlertTitle>
          <AlertAction>
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" data-testid="auto-mitigation-end">
                  {m.attacks_mitigation_end()}
                </Button>
              }
              title={m.attacks_mitigation_end_confirm({ name: siteName })}
              note={m.attacks_mitigation_end_note({ level: levelLabel(settings.threshold) })}
              confirmLabel={m.attacks_mitigation_end()}
              onConfirm={() => end.mutateAsync({ id: siteId })}
            />
          </AlertAction>
        </Alert>
      ) : null}
      {paused ? (
        <SafetyNote data-testid="auto-mitigation-paused">
          {m.attacks_mitigation_paused({ level: levelLabel(settings.threshold) })}
        </SafetyNote>
      ) : null}
      {lastError ? (
        <SafetyNote data-testid="auto-mitigation-failed">
          {m.attacks_mitigation_failed()}
        </SafetyNote>
      ) : null}
      {settings.enabled && unreachable ? (
        <SafetyNote data-testid="auto-mitigation-unreachable">{unreachable}</SafetyNote>
      ) : null}
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(
          [
            [
              "state",
              m.attacks_mitigation_state(),
              <Badge
                key="state"
                variant={active ? "destructive" : settings.enabled ? "secondary" : "outline"}
              >
                {active
                  ? m.protection_on()
                  : settings.enabled
                    ? m.attacks_mitigation_armed()
                    : m.attacks_mitigation_off()}
              </Badge>,
            ],
            ["threshold", m.attacks_mitigation_threshold(), levelLabel(settings.threshold)],
            [
              "duration",
              m.attacks_mitigation_duration(),
              m.attacks_mitigation_minutes({ minutes: settings.durationMinutes }),
            ],
            [
              "level",
              m.attacks_mitigation_level_now(),
              <Badge key="level" variant={level === "normal" ? "outline" : "destructive"}>
                {levelLabel(level)}
              </Badge>,
            ],
          ] as const
        ).map(([key, label, value]) => (
          <div key={key} className="flex min-w-0 flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm" data-testid={`auto-mitigation-${key}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </CardContent>
  );
}

interface Draft {
  enabled: boolean;
  threshold: AutoMitigationLevel;
  minutes: string;
}

const toDraft = (settings: AutoMitigationSettings | null): Draft => ({
  enabled: settings?.enabled ?? true,
  threshold: settings?.threshold ?? "pow",
  minutes: String(settings?.durationMinutes ?? 30),
});

function MitigationDialog({
  open,
  onOpenChange,
  siteId,
  mitigation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  mitigation: AutoMitigation;
}) {
  const save = useMutation({
    ...orpc.autoMitigation.update.mutationOptions(),
    meta: { invalidates: MITIGATION_VIEWS, success: m.common_saved },
  });
  const [draft, setDraft] = React.useState(() => toDraft(mitigation.settings));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const minutes = integerIn(draft.minutes, MIN_MINUTES, MAX_MINUTES);
  const levels: Option<AutoMitigationLevel>[] = AUTO_MITIGATION_LEVELS.map((value) => ({
    value,
    label: levelLabel(value),
  }));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.attacks_mitigation_title()}
      submitLabel={m.common_save()}
      submitTestId="auto-mitigation-save"
      submitDisabled={minutes === undefined}
      onSubmit={async () => {
        if (minutes === undefined) return;
        await save.mutateAsync({
          id: siteId,
          enabled: draft.enabled,
          threshold: draft.threshold,
          durationMinutes: minutes,
          ...(mitigation.updatedAt ? { expectedUpdatedAt: mitigation.updatedAt } : {}),
        });
        onOpenChange(false);
      }}
    >
      <SwitchField
        id="auto-mitigation-enabled"
        label={m.attacks_mitigation_enabled()}
        checked={draft.enabled}
        onCheckedChange={(checked) => set("enabled", checked)}
        testId="auto-mitigation-enabled"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormSelect
          id="auto-mitigation-threshold"
          label={m.attacks_mitigation_threshold()}
          value={draft.threshold}
          options={levels}
          onChange={(value) => set("threshold", value)}
          testId="auto-mitigation-threshold-select"
        />
        <NumberField
          id="auto-mitigation-duration"
          label={m.attacks_mitigation_duration()}
          value={draft.minutes}
          onChange={(value) => set("minutes", value)}
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          step={1}
          invalid={minutes === undefined}
          testId="auto-mitigation-duration-input"
        />
      </div>
      <SafetyNote>{m.attacks_mitigation_hold_note()}</SafetyNote>
    </FormDialog>
  );
}
