import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { AuthFrame, AuthShell } from "@/components/auth-shell";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import { useAction } from "@/hooks/use-action";
import { authClient } from "@/lib/auth-client";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery({
      ...orpc.system.status.queryOptions(),
      staleTime: 0,
    });
    if (status.initialized) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setup = useMutation(orpc.system.setup.mutationOptions());
  const signIn = useAction();
  const pending = setup.isPending || signIn.pending;
  return (
    <AuthShell className="max-w-md">
      <AuthFrame>
        <Panel>
          <PanelHeader className="flex-col items-stretch gap-5">
            <SetupSteps />
            <PanelTitle className="text-title">{m.setup_title()}</PanelTitle>
          </PanelHeader>
          <PanelContent>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const input = {
                  setupToken: String(data.get("setupToken") ?? "").trim(),
                  name: String(data.get("adminName") ?? ""),
                  email: String(data.get("email") ?? ""),
                  password: String(data.get("password") ?? ""),
                };
                try {
                  await setup.mutateAsync(input);
                } catch {
                  return; // rendered below via setup.error
                }
                await signIn.run(async () => {
                  const { error } = await authClient.signIn.email({
                    email: input.email,
                    password: input.password,
                  });
                  // The cached status still says "not initialized"; start from a clean cache.
                  queryClient.clear();
                  toast.success(m.setup_done());
                  // No node yet: the console starts with adding one (the default cluster exists).
                  if (!error) return navigate({ to: "/clusters", search: { enroll: true } });
                  // The account exists; signing in is left to the sign-in page.
                  toast.error(localizeError(error, m.login_failed()));
                  return navigate({ to: "/login" });
                });
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="setupToken">{m.setup_token()}</FieldLabel>
                  <Input
                    id="setupToken"
                    name="setupToken"
                    required
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    placeholder={m.setup_token_placeholder()}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="adminName">{m.setup_name()}</FieldLabel>
                  <Input id="adminName" name="adminName" required autoComplete="name" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="email">{m.setup_email()}</FieldLabel>
                  <Input id="email" name="email" type="email" required autoComplete="username" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">{m.setup_password()}</FieldLabel>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    minLength={12}
                    required
                    autoComplete="new-password"
                    placeholder={m.setup_password_placeholder()}
                  />
                </Field>
                {setup.isError ? (
                  <FieldError data-testid="setup-error">{errorMessage(setup.error)}</FieldError>
                ) : null}
                <Button type="submit" disabled={pending} data-testid="setup-submit">
                  {pending ? <Spinner /> : null}
                  {m.setup_submit()}
                </Button>
              </FieldGroup>
            </form>
          </PanelContent>
        </Panel>
      </AuthFrame>
    </AuthShell>
  );
}

const STEPS = [m.setup_step_account, m.setup_step_node, m.setup_step_site];

/** Where setup is on the way to a working console: this account, then a node, then a site. */
function SetupSteps() {
  return (
    <ol
      aria-label={m.setup_steps_label()}
      className="flex items-center gap-2 text-dense"
      data-testid="setup-steps"
    >
      {STEPS.map((label, index) => {
        const current = index === 0;
        return (
          <li
            key={label()}
            aria-current={current ? "step" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 last:flex-none"
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-xs tabular-nums",
                current
                  ? "bg-primary text-primary-foreground"
                  : "border border-input-hover text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <span
              className={cn(
                "truncate",
                current ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {label()}
            </span>
            {index < STEPS.length - 1 ? (
              <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
