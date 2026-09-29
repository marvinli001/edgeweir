import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { AuthFrame, AuthShell } from "@/components/auth-shell";
import { roleLabel } from "@/components/members";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { authClient } from "@/lib/auth-client";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

/** Public page of an invitation link. */
export const Route = createFileRoute("/invite/$id")({
  component: InvitePage,
});

function InvitePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const info = useQuery({ ...orpc.invitations.get.queryOptions({ input: { id } }), retry: false });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => (await authClient.getSession()).data ?? null,
  });
  const action = useAction();
  const pending = action.pending;
  const [error, setError] = React.useState<string | null>(null);

  const accept = async (account?: { name: string; password: string }) => {
    setError(null);
    try {
      await action.run(async () => {
        const joined = await client.invitations.accept({ id, ...account });
        if (account && info.data) {
          const { error: signInError } = await authClient.signIn.email({
            email: info.data.email,
            password: account.password,
          });
          if (signInError) throw signInError;
        }
        await client.account.setActiveOrganization({ organizationId: joined.organizationId });
        queryClient.clear();
        toast.success(m.invite_joined({ organization: info.data?.organizationName ?? "" }));
        await navigate({ to: "/overview" });
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const signedInAs = session.data?.user.email;
  return (
    <AuthShell>
      <AuthFrame>
        <Card>
          {info.isPending || session.isPending ? (
            <CardContent>
              <LoadingState />
            </CardContent>
          ) : info.isError ? (
            <CardContent>
              <ErrorState error={info.error} />
            </CardContent>
          ) : (
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-xl" data-testid="invite-title">
                  {m.invite_title({ organization: info.data.organizationName })}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap justify-center gap-2">
                  <Badge variant="outline">{info.data.email}</Badge>
                  <Badge variant="secondary">{roleLabel(info.data.role)}</Badge>
                </div>
                {info.data.userExists ? (
                  signedInAs === info.data.email ? (
                    <FieldGroup>
                      {error ? <FieldError>{error}</FieldError> : null}
                      <Button
                        disabled={pending}
                        onClick={() => accept()}
                        data-testid="invite-accept"
                      >
                        {pending ? <Spinner /> : null}
                        {m.invite_accept()}
                      </Button>
                    </FieldGroup>
                  ) : (
                    <Link
                      to="/login"
                      search={{ redirect: `/invite/${id}` }}
                      className={buttonVariants({ className: "w-full" })}
                    >
                      {m.invite_sign_in()}
                    </Link>
                  )
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      void accept({
                        name: String(data.get("inviteName") ?? "").trim(),
                        password: String(data.get("invitePassword") ?? ""),
                      });
                    }}
                  >
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="inviteName">{m.setup_name()}</FieldLabel>
                        <Input id="inviteName" name="inviteName" required autoComplete="name" />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="invitePassword">{m.setup_password()}</FieldLabel>
                        <Input
                          id="invitePassword"
                          name="invitePassword"
                          type="password"
                          minLength={12}
                          required
                          autoComplete="new-password"
                          placeholder={m.setup_password_placeholder()}
                        />
                      </Field>
                      {error ? <FieldError>{error}</FieldError> : null}
                      <Button type="submit" disabled={pending} data-testid="invite-accept">
                        {pending ? <Spinner /> : null}
                        {m.invite_accept()}
                      </Button>
                    </FieldGroup>
                  </form>
                )}
              </CardContent>
            </>
          )}
        </Card>
      </AuthFrame>
    </AuthShell>
  );
}
