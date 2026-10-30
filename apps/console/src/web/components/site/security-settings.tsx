import {
  type FeatureAvailability,
  type InterstitialRule,
  MAX_INTERSTITIAL_RULES,
  SESSION_DETECTION_MODES,
  type SessionDetectionSettings,
  validInterstitialHost,
  validInterstitialPath,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { DisabledHint } from "@/components/disabled-hint";
import { FormDialog } from "@/components/form-dialog";
import { type Option, OptionSelect } from "@/components/form-select";
import { FieldError, FieldLegend, FieldSet } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { combineQueries, QueryView } from "@/components/states";
import { useDialogState } from "@/hooks/use-dialog-state";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

type Mode = SessionDetectionSettings["mode"];

const modeLabel = (mode: Mode) =>
  ({
    off: m.session_detection_off,
    monitor: m.session_detection_monitor,
    enforce: m.session_detection_enforce,
  })[mode]();

const VIEWS = () => [orpc.sessionDetection.key(), orpc.sites.key()];

/**
 * The site's security settings as a list: each row a setting with its tags, what it is configured
 * with and its state. Session detection (the bot score) changes state from the row; its
 * interstitial and the per-host rules open in a dialog.
 */
export function SecuritySettings({ siteId }: { siteId: string }) {
  const settings = useQuery(orpc.sessionDetection.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Panel className="animate-enter" data-testid="security-settings">
      <PanelHeader>
        <PanelTitle>{m.security_settings_title()}</PanelTitle>
      </PanelHeader>
      <PanelContent>
        <QueryView query={combineQueries(settings, features)}>
          {([saved, { sessionDetection }]) => (
            <SettingsList siteId={siteId} saved={saved} availability={sessionDetection} />
          )}
        </QueryView>
      </PanelContent>
    </Panel>
  );
}

function SettingsList({
  siteId,
  saved,
  availability,
}: {
  siteId: string;
  saved: SessionDetectionSettings;
  availability: FeatureAvailability;
}) {
  const dialog = useDialogState();
  const save = useMutation({
    ...orpc.sessionDetection.update.mutationOptions(),
    meta: { invalidates: VIEWS(), success: m.common_saved, toastError: true },
  });
  const options: Option<Mode>[] = SESSION_DETECTION_MODES.map((value) => ({
    value,
    label: modeLabel(value),
  }));
  // Nodes without the feature: it cannot be turned on (it can be turned off).
  const blocked = !availability.available && saved.mode === "off";
  const interstitialOn = saved.interstitial;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div
        className="hidden h-10 grid-cols-[minmax(0,1fr)_10rem_9rem] items-center gap-4 bg-well px-4 text-[13px] text-muted-foreground sm:grid"
        aria-hidden="true"
      >
        <span>{m.security_settings_name()}</span>
        <span>{m.security_settings_config()}</span>
        <span>{m.security_settings_state()}</span>
      </div>
      <div
        className="grid gap-3 border-border px-4 py-3 sm:grid-cols-[minmax(0,1fr)_10rem_9rem] sm:items-center sm:gap-4 sm:border-t"
        data-testid="session-detection-row"
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="font-medium text-sm">{m.session_detection_name()}</span>
          <span className="flex flex-wrap gap-1.5">
            <Badge size="sm" tone="neutral">
              {m.session_detection_tag_score()}
            </Badge>
            <Badge size="sm" tone="neutral">
              {m.session_detection_tag_automation()}
            </Badge>
          </span>
          {availability.available ? null : (
            <SafetyNote data-testid="session-detection-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          )}
        </div>
        <DisabledHint
          reason={saved.mode === "off" && m.session_detection_interstitial_off_hint()}
          className="justify-self-start"
        >
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={saved.mode === "off"}
            onClick={() => dialog.show()}
            data-testid="session-detection-interstitial"
          >
            <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
            {interstitialOn
              ? m.session_detection_interstitial_on()
              : m.session_detection_interstitial_background()}
            {saved.interstitialRules.length ? (
              <Badge size="sm" tone="info">
                {saved.interstitialRules.length}
              </Badge>
            ) : null}
          </Button>
        </DisabledHint>
        <DisabledHint reason={blocked && m.feature_unavailable_nodes()}>
          <OptionSelect
            value={saved.mode}
            options={options}
            size="sm"
            className="w-36"
            label={m.session_detection_state_label()}
            disabled={blocked || save.isPending}
            testId="session-detection-mode"
            onChange={(mode) => {
              if (mode !== saved.mode) save.mutate({ id: siteId, ...saved, mode });
            }}
          />
        </DisabledHint>
      </div>
      <InterstitialDialog
        key={dialog.key}
        open={dialog.open}
        onOpenChange={dialog.onOpenChange}
        siteId={siteId}
        saved={saved}
      />
    </div>
  );
}

type RuleDraft = InterstitialRule & { key: number };

/** The site's interstitial default and its rules by host and path, the first match winning. */
function InterstitialDialog({
  open,
  onOpenChange,
  siteId,
  saved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  saved: SessionDetectionSettings;
}) {
  const save = useMutation({
    ...orpc.sessionDetection.update.mutationOptions(),
    meta: { invalidates: VIEWS(), success: m.common_saved },
  });
  const nextKey = React.useRef(saved.interstitialRules.length);
  const [interstitial, setInterstitial] = React.useState(saved.interstitial);
  const [rules, setRules] = React.useState<RuleDraft[]>(() =>
    saved.interstitialRules.map((rule, key) => ({ ...rule, key })),
  );
  const update = (key: number, patch: Partial<InterstitialRule>) =>
    setRules((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const invalid = rules.some(
    (r) => !validInterstitialHost(r.host.trim()) || !validInterstitialPath(r.pathPrefix.trim()),
  );
  const ruleOptions: Option<"on" | "off">[] = [
    { value: "on", label: m.session_detection_rule_on() },
    { value: "off", label: m.session_detection_rule_off() },
  ];
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.session_detection_interstitial_title()}
      submitLabel={m.common_save()}
      submitTestId="session-detection-interstitial-save"
      submitDisabled={invalid}
      className="sm:max-w-2xl"
      onSubmit={async () => {
        await save.mutateAsync({
          id: siteId,
          mode: saved.mode,
          interstitial,
          interstitialRules: rules.map(({ host, pathPrefix, interstitial: on }) => ({
            host: host.trim().toLowerCase(),
            pathPrefix: pathPrefix.trim(),
            interstitial: on,
          })),
        });
        onOpenChange(false);
      }}
    >
      <SwitchField
        id="session-detection-interstitial-default"
        label={m.session_detection_interstitial_default()}
        checked={interstitial}
        className="self-start"
        testId="session-detection-interstitial-default"
        onCheckedChange={setInterstitial}
      />
      {saved.mode === "monitor" ? (
        <SafetyNote>{m.session_detection_monitor_note()}</SafetyNote>
      ) : null}
      <FieldSet className="gap-2">
        <FieldLegend variant="label">{m.session_detection_rules()}</FieldLegend>
        {rules.length ? (
          <ul className="flex flex-col gap-2" data-testid="session-detection-rules">
            {rules.map((rule, index) => {
              const hostBad = !validInterstitialHost(rule.host.trim());
              const pathBad = !validInterstitialPath(rule.pathPrefix.trim());
              return (
                <li key={rule.key} className="flex flex-col gap-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_7rem_auto]">
                    <Input
                      value={rule.host}
                      aria-label={m.session_detection_rule_host()}
                      placeholder={m.session_detection_rule_host_any()}
                      aria-invalid={hostBad || undefined}
                      autoComplete="off"
                      spellCheck={false}
                      className="col-span-2 sm:col-span-1"
                      data-testid="session-detection-rule-host"
                      onChange={(e) => update(rule.key, { host: e.target.value })}
                    />
                    <Input
                      value={rule.pathPrefix}
                      aria-label={m.session_detection_rule_path()}
                      placeholder={m.session_detection_rule_path_any()}
                      aria-invalid={pathBad || undefined}
                      autoComplete="off"
                      spellCheck={false}
                      data-testid="session-detection-rule-path"
                      onChange={(e) => update(rule.key, { pathPrefix: e.target.value })}
                    />
                    <OptionSelect
                      value={rule.interstitial ? "on" : "off"}
                      options={ruleOptions}
                      label={m.session_detection_rule_interstitial()}
                      className="w-28"
                      testId="session-detection-rule-interstitial"
                      onChange={(value) => update(rule.key, { interstitial: value === "on" })}
                    />
                    <Button
                      className="icon-button"
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={m.session_detection_rule_remove({ index: index + 1 })}
                      onClick={() =>
                        setRules((current) => current.filter((r) => r.key !== rule.key))
                      }
                      data-testid="session-detection-rule-remove"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                    </Button>
                  </div>
                  {hostBad ? (
                    <FieldError>{m.session_detection_rule_host_invalid()}</FieldError>
                  ) : null}
                  {pathBad ? (
                    <FieldError>{m.session_detection_rule_path_invalid()}</FieldError>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="self-start"
          disabled={rules.length >= MAX_INTERSTITIAL_RULES}
          data-testid="session-detection-rule-add"
          onClick={() => {
            const key = nextKey.current++;
            setRules((current) => [
              ...current,
              { key, host: "", pathPrefix: "", interstitial: !interstitial },
            ]);
          }}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.session_detection_rule_add()}
        </Button>
      </FieldSet>
    </FormDialog>
  );
}
