import { loginAllowListContains, MAX_LOGIN_ALLOWED_CIDRS, normalizeCidr } from "@edgeweir/contract";
import { Button } from "@/components/arc/button/button";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { splitList } from "@/lib/lists";
import { orpc } from "@/lib/orpc";

/**
 * System page card: the networks the operator may sign in from (empty: anyone), with the
 * address the console sees for this browser. The server refuses a list without it.
 */
export function LoginAllowListCard() {
  return (
    <SettingsCard
      title={m.system_login_allow_list_title()}
      className="animate-enter"
      style={{ animationDelay: "240ms" }}
      testId="login-allow-list-card"
      query={orpc.settings.loginAllowList.queryOptions()}
      mutation={orpc.settings.setLoginAllowList.mutationOptions()}
      toDraft={(list) => ({ text: list.cidrs.join("\n") })}
      toInput={(d) => ({ cidrs: splitList(d.text) })}
      check={({ cidrs }) => {
        const invalid = cidrs.find((entry) => normalizeCidr(entry) === null);
        if (invalid !== undefined) return m.system_login_allow_list_invalid({ value: invalid });
        if (cidrs.length > MAX_LOGIN_ALLOWED_CIDRS)
          return m.system_login_allow_list_too_many({ max: MAX_LOGIN_ALLOWED_CIDRS });
        return null;
      }}
      noValidate
      contentClassName="flex flex-col gap-3"
      saveTestId="login-allow-list-save"
      errorTestId="login-allow-list-error"
    >
      {({ value, draft, set, error }) => {
        const listed = loginAllowListContains(splitList(draft.text), value.currentIp);
        return (
          <>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="login-allow-list">
                {m.system_login_allow_list_label()}
              </FieldLabel>
              <Textarea
                id="login-allow-list"
                value={draft.text}
                rows={4}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => set({ text: event.target.value })}
                placeholder={value.currentIp || "203.0.113.0/24"}
                aria-invalid={error ? true : undefined}
                className="min-h-28 font-mono text-sm"
                data-testid="login-allow-list"
              />
            </Field>
            {value.currentIp ? (
              <div
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-well px-3 py-1.5"
                data-testid="login-allow-list-current"
              >
                <span className="min-w-0 break-all">
                  {m.system_login_allow_list_current({ ip: value.currentIp })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  disabled={listed}
                  onClick={() =>
                    set({ text: [...splitList(draft.text), value.currentIp].join("\n") })
                  }
                  data-testid="login-allow-list-add-current"
                >
                  {m.system_login_allow_list_add_current()}
                </Button>
              </div>
            ) : null}
            {value.proxyHint ? (
              <SafetyNote data-testid="login-allow-list-proxy-hint">
                {m.system_login_allow_list_proxy_hint()}
              </SafetyNote>
            ) : null}
            <SafetyNote>{m.system_login_allow_list_note()}</SafetyNote>
          </>
        );
      }}
    </SettingsCard>
  );
}
