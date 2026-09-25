import type { Invitation, Member } from "@edgeweir/contract";
import { Delete02Icon, UserAdd01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { type Columns, DataTable } from "@/components/data-table";
import { InviteDialog, invitationLink, RoleSelect, roleLabel } from "@/components/members";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/members")({
  beforeLoad: ({ context }) => {
    const role = context.me.activeOrganization?.role;
    if (role !== "owner" && role !== "admin") throw redirect({ to: "/" });
  },
  component: MembersPage,
});

function MembersPage() {
  const { me } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const members = useQuery(orpc.members.list.queryOptions());
  const current = useQuery(orpc.account.me.queryOptions({ initialData: me }));
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const role = current.data.activeOrganization?.role ?? "member";
  const canGrantOwner = role === "owner";
  const updateRole = useMutation(orpc.members.updateRole.mutationOptions());
  const remove = useMutation(orpc.members.remove.mutationOptions());
  const cancel = useMutation(orpc.members.cancelInvitation.mutationOptions());
  const invite = useMutation(orpc.members.invite.mutationOptions());
  const refresh = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: orpc.members.key() }),
    [queryClient],
  );

  const memberColumns = React.useMemo<Columns<Member>>(
    () => [
      {
        id: "name",
        header: () => m.members_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">{row.original.email}</span>
          </div>
        ),
      },
      {
        id: "role",
        header: () => m.members_col_role(),
        cell: ({ row }) =>
          row.original.userId === current.data.user.id ? (
            <Badge variant="secondary">{roleLabel(row.original.role)}</Badge>
          ) : (
            <RoleSelect
              value={row.original.role}
              canGrantOwner={canGrantOwner}
              disabled={row.original.role === "owner" && !canGrantOwner}
              onChange={async (next) => {
                try {
                  await updateRole.mutateAsync({ id: row.original.id, role: next });
                  toast.success(m.members_role_updated({ name: row.original.name }));
                } catch (error) {
                  toast.error(errorMessage(error));
                } finally {
                  await refresh();
                }
              }}
            />
          ),
      },
      {
        id: "security",
        header: () => m.members_col_2fa(),
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.original.twoFactorEnabled ? (
              <Badge variant="secondary">{m.members_2fa_on()}</Badge>
            ) : (
              <Badge variant="outline">{m.members_2fa_off()}</Badge>
            )}
            {row.original.disabled ? (
              <Badge variant="destructive">{m.users_disabled()}</Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: "joined",
        header: () => m.members_col_joined(),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{timeAgo(row.original.createdAt)}</span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) =>
          row.original.userId === current.data.user.id ||
          (row.original.role === "owner" && !canGrantOwner) ? null : (
            <div className="flex justify-end">
              <ConfirmDialog
                trigger={
                  <Button size="icon-sm" variant="ghost" aria-label={m.common_remove()}>
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  </Button>
                }
                destructive
                title={m.members_remove_confirm({ name: row.original.name })}
                confirmLabel={m.common_remove()}
                onConfirm={async () => {
                  try {
                    await remove.mutateAsync({ id: row.original.id });
                    await refresh();
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              />
            </div>
          ),
      },
    ],
    [current.data.user.id, canGrantOwner, updateRole, remove, refresh],
  );

  return (
    <Page
      title={m.members_title()}
      actions={
        <Button size="sm" onClick={() => setInviteOpen(true)} data-testid="invite-member">
          <HugeiconsIcon icon={UserAdd01Icon} strokeWidth={2} />
          {m.members_invite()}
        </Button>
      }
    >
      <PolicyCard requireTwoFactor={current.data.activeOrganization?.requireTwoFactor ?? false} />
      {members.isPending ? (
        <LoadingState />
      ) : members.isError ? (
        <ErrorState error={members.error} onRetry={() => members.refetch()} />
      ) : (
        <>
          <DataTable
            data={members.data.members}
            columns={memberColumns}
            getRowId={(r) => r.id}
            testId="members-table"
          />
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">{m.members_invitations()}</h2>
            {members.data.invitations.length === 0 ? (
              <EmptyState icon={UserGroupIcon} title={m.members_invitations_empty()} />
            ) : (
              <ul className="divide-y rounded-2xl border bg-card text-sm shadow-xs">
                {members.data.invitations.map((invitation, index) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    index={index}
                    onCancel={async () => {
                      try {
                        await cancel.mutateAsync({ id: invitation.id });
                        await refresh();
                      } catch (error) {
                        toast.error(errorMessage(error));
                      }
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        canGrantOwner={canGrantOwner}
        submit={(input) => invite.mutateAsync(input)}
      />
    </Page>
  );
}

function InvitationRow({
  invitation,
  index,
  onCancel,
}: {
  invitation: Invitation;
  index: number;
  onCancel: () => Promise<void>;
}) {
  return (
    <li
      className="flex flex-wrap items-center gap-3 px-3 py-2.5 animate-enter"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      data-testid="invitation-row"
    >
      <span className="font-medium">{invitation.email}</span>
      <Badge variant="outline">{roleLabel(invitation.role)}</Badge>
      <span className="ml-auto text-xs text-muted-foreground">
        {m.members_invitation_expires({ time: formatDateTime(invitation.expiresAt) })}
      </span>
      <CopyButton value={invitationLink(invitation.id)} iconOnly />
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="ghost">
            {m.common_cancel()}
          </Button>
        }
        title={m.members_cancel_invitation({ email: invitation.email })}
        onConfirm={onCancel}
      />
    </li>
  );
}

function PolicyCard({ requireTwoFactor }: { requireTwoFactor: boolean }) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.organization.update.mutationOptions());
  return (
    <Card className="animate-enter">
      <CardHeader>
        <CardTitle>{m.members_policy()}</CardTitle>
      </CardHeader>
      <CardContent>
        <Field orientation="horizontal">
          <Switch
            id="requireTwoFactor"
            checked={requireTwoFactor}
            disabled={update.isPending}
            onCheckedChange={async (checked) => {
              try {
                const me = await update.mutateAsync({ requireTwoFactor: checked });
                queryClient.setQueryData(orpc.account.me.queryKey(), me);
                toast.success(m.common_saved());
              } catch (error) {
                toast.error(errorMessage(error));
              }
            }}
            data-testid="require-2fa"
          />
          <FieldLabel htmlFor="requireTwoFactor">{m.members_require_2fa()}</FieldLabel>
        </Field>
      </CardContent>
    </Card>
  );
}
