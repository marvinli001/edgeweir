import { DEMO_EMAIL, DEMO_PASSWORD } from "@edgeweir/contract";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { SwitchField } from "@/components/site/fields";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** System page card: the view-only demo account beside the operator's own. */
export function DemoSettingsCard() {
  return (
    <SettingsCard
      title={m.system_demo_title()}
      className="animate-enter"
      style={{ animationDelay: "260ms" }}
      query={orpc.settings.demo.queryOptions()}
      mutation={orpc.settings.setDemo.mutationOptions()}
      toDraft={(s) => ({ enabled: s.enabled })}
      toInput={(d) => ({ enabled: d.enabled })}
      saveTestId="demo-settings-save"
    >
      {({ value, draft, set }) => (
        <>
          <SwitchField
            id="demo-enabled"
            label={m.system_demo_enabled()}
            checked={draft.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
            className="self-start"
            testId="demo-enabled"
          />
          {value.enabled ? (
            <SafetyNote data-testid="demo-credentials">
              {m.system_demo_credentials({ email: DEMO_EMAIL, password: DEMO_PASSWORD })}
            </SafetyNote>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}
