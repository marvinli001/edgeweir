import type { Organization, OrgRole, User } from "@edgeweir/contract";
import {
  Add01Icon,
  Building03Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  UserAdd01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { InviteDialog, RoleSelect, roleLabel } from "@/components/members";
import { OrgLimitsDialog } from "@/components/org-limits";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAction } from "@/hooks/use-action";
import { m, timeAgo } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

const NONE = "__none__";

export const Route = createFileRoute("/_app/admin/organizations")({
  validateSearch: z.object({ tab: z.enum(["organizations", "users"]).optional() }),
  component: OrganizationsPage,
});

function OrganizationsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab = search.tab ?? "organizations";
  const [createOrgOpen, setCreateOrgOpen] = React.useState(false);
  const [createUserOpen, setCreateUserOpen] = React.useState(false);
  return (
    <Page
      title={m.orgs_title()}
      actions={
        tab === "organizations" ? (
          <Button size="sm" onClick={() => setCreateOrgOpen(true)} data-testid="create-org">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.orgs_create()}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setCreateUserOpen(true)} data-testid="create-user">
            <HugeiconsIcon icon={UserAdd01Icon} strokeWidth={2} />
            {m.users_create()}
          </Button>
        )
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) =>
          navigate({
            search: { tab: value === "users" ? "users" : undefined },
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="organizations" data-testid="tab-organizations">
            {m.orgs_tab()}
          </TabsTrigger>
          <TabsTrigger value="users" data-testid="tab-users">
            {m.users_tab()}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="organizations" className="flex flex-col gap-4 animate-enter">
          <OrganizationsTab onCreate={() => setCreateOrgOpen(true)} />
        </TabsContent>
        <TabsContent value="users" className="flex flex-col gap-4 animate-enter">
          <UsersTab />
        </TabsContent>
      </Tabs>
      <OrganizationDialog open={createOrgOpen} onOpenChange={setCreateOrgOpen} />
      <CreateUserDialog open={createUserOpen} onOpenChange={setCreateUserOpen} />
    </Page>
  );
}

function ClusterSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const items = [
    { label: m.orgs_default_cluster_auto(), value: NONE },
    ...(clusters.data ?? []).map((c) => ({ label: c.name, value: c.id })),
  ];
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(!v || v === NONE ? null : String(v))}
      items={items}
    >
      <SelectTrigger className="w-full" data-testid="default-cluster-select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Create an organization, or edit its name and policy when `organization` is given. */
function OrganizationDialog({
  organization,
  open,
  onOpenChange,
}: {
  organization?: Organization;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.organizations.create.mutationOptions());
  const update = useMutation(orpc.organizations.update.mutationOptions());
  const [clusterId, setClusterId] = React.useState(organization?.defaultClusterId ?? null);
  const [requireTwoFactor, setRequireTwoFactor] = React.useState(
    organization?.requireTwoFactor ?? false,
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={organization ? m.orgs_edit() : m.orgs_create()}
      submitLabel={organization ? m.common_save() : m.common_create()}
      submitTestId="org-submit"
      onSubmit={async (data) => {
        const name = String(data.get("orgName") ?? "").trim();
        if (organization) {
          await update.mutateAsync({
            id: organization.id,
            name,
            defaultClusterId: clusterId,
            requireTwoFactor,
          });
        } else {
          const slug = String(data.get("orgSlug") ?? "").trim();
          const created = await create.mutateAsync({
            name,
            slug: slug || undefined,
            defaultClusterId: clusterId,
          });
          if (requireTwoFactor) {
            await update.mutateAsync({ id: created.id, requireTwoFactor });
          }
        }
        await queryClient.invalidateQueries();
        toast.success(m.common_saved());
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="orgName">{m.orgs_name()}</FieldLabel>
        <Input
          id="orgName"
          name="orgName"
          required
          maxLength={100}
          defaultValue={organization?.name}
        />
      </Field>
      {organization ? null : (
        <Field>
          <FieldLabel htmlFor="orgSlug">{m.orgs_slug()}</FieldLabel>
          <Input
            id="orgSlug"
            name="orgSlug"
            maxLength={48}
            pattern="[a-z0-9][a-z0-9-]*"
            placeholder={m.orgs_slug_placeholder()}
            className="font-mono"
          />
        </Field>
      )}
      <Field>
        <FieldLabel>{m.orgs_default_cluster()}</FieldLabel>
        <ClusterSelect value={clusterId} onChange={setClusterId} />
      </Field>
      <Field orientation="horizontal">
        <Switch
          id="orgRequire2fa"
          checked={requireTwoFactor}
          onCheckedChange={setRequireTwoFactor}
        />
        <FieldLabel htmlFor="orgRequire2fa">{m.members_require_2fa()}</FieldLabel>
      </Field>
    </FormDialog>
  );
}

function OrganizationsTab({ onCreate }: { onCreate: () => void }) {
  const orgs = useQuery(orpc.organizations.list.queryOptions());
  const [editing, setEditing] = React.useState<Organization | null>(null);
  const [membersOf, setMembersOf] = React.useState<Organization | null>(null);
  const [limitsOf, setLimitsOf] = React.useState<Organization | null>(null);
  const columns = React.useMemo<Columns<Organization>>(
    () => [
      {
        id: "name",
        header: () => m.orgs_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium" data-testid="org-name">
              {row.original.name}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{row.original.slug}</span>
          </div>
        ),
      },
      {
        id: "members",
        header: () => m.orgs_members(),
        cell: ({ row }) => <span className="tabular-nums">{row.original.memberCount}</span>,
      },
      {
        id: "sites",
        header: () => m.admin_sites(),
        cell: ({ row }) => <span className="tabular-nums">{row.original.siteCount}</span>,
      },
      {
        id: "cluster",
        header: () => m.orgs_default_cluster(),
        cell: ({ row }) =>
          row.original.defaultClusterName ? (
            <Badge variant="secondary">{row.original.defaultClusterName}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "policy",
        header: () => m.members_col_2fa(),
        cell: ({ row }) =>
          row.original.requireTwoFactor ? (
            <Badge variant="outline">{m.orgs_2fa_required()}</Badge>
          ) : null,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMembersOf(row.original)}
              data-testid="org-members"
            >
              {m.orgs_members()}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLimitsOf(row.original)}
              data-testid="org-limits"
            >
              {m.org_limits_edit()}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(row.original)}>
              {m.orgs_edit()}
            </Button>
          </div>
        ),
      },
    ],
    [],
  );
  return (
    <>
      {orgs.isPending ? (
        <LoadingState />
      ) : orgs.isError ? (
        <ErrorState error={orgs.error} onRetry={() => orgs.refetch()} />
      ) : orgs.data.length === 0 ? (
        <EmptyState icon={Building03Icon} title={m.orgs_empty()}>
          <Button onClick={onCreate}>{m.orgs_create()}</Button>
        </EmptyState>
      ) : (
        <DataTable data={orgs.data} columns={columns} getRowId={(o) => o.id} testId="orgs-table" />
      )}
      {editing ? (
        <OrganizationDialog
          key={editing.id}
          organization={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
      {membersOf ? (
        <OrgMembersDialog organization={membersOf} onClose={() => setMembersOf(null)} />
      ) : null}
      {limitsOf ? (
        <OrgLimitsDialog
          key={limitsOf.id}
          organization={limitsOf}
          onClose={() => setLimitsOf(null)}
        />
      ) : null}
    </>
  );
}

function OrgMembersDialog({
  organization,
  onClose,
}: {
  organization: Organization;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const members = useQuery(
    orpc.organizations.members.queryOptions({ input: { id: organization.id } }),
  );
  const users = useQuery(orpc.users.list.queryOptions({ input: {} }));
  const [userId, setUserId] = React.useState("");
  const [role, setRole] = React.useState<OrgRole>("member");
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const refresh = () => queryClient.invalidateQueries();
  const action = useAction();
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await action.run(async () => {
        await fn();
        await refresh();
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const memberIds = new Set(members.data?.members.map((x) => x.userId));
  const candidates = (users.data ?? []).filter((u) => !memberIds.has(u.id));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.orgs_members_title({ name: organization.name })}</DialogTitle>
        </DialogHeader>
        {members.isPending ? (
          <LoadingState />
        ) : members.isError ? (
          <ErrorState error={members.error} onRetry={() => members.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
            {members.data.members.length === 0 ? (
              <EmptyState icon={UserIcon} title={m.orgs_members_empty()} />
            ) : (
              <ul className="divide-y rounded-2xl border text-sm">
                {members.data.members.map((member) => (
                  <li key={member.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">{member.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                    </div>
                    <RoleSelect
                      value={member.role}
                      canGrantOwner
                      disabled={action.pending}
                      onChange={(next) =>
                        run(() =>
                          client.organizations.updateMember({
                            organizationId: organization.id,
                            memberId: member.id,
                            role: next,
                          }),
                        )
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={m.common_remove()}
                      disabled={action.pending}
                      onClick={() =>
                        run(() =>
                          client.organizations.removeMember({
                            organizationId: organization.id,
                            memberId: member.id,
                          }),
                        )
                      }
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {members.data.invitations.length ? (
              <ul className="flex flex-wrap gap-2">
                {members.data.invitations.map((inv) => (
                  <Badge key={inv.id} variant="outline">
                    {inv.email} · {roleLabel(inv.role)}
                  </Badge>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-end gap-2">
              <Field className="min-w-48 flex-1">
                <FieldLabel>{m.orgs_add_member()}</FieldLabel>
                <Select
                  value={userId}
                  onValueChange={(v) => v && setUserId(String(v))}
                  items={candidates.map((u) => ({ label: `${u.name} <${u.email}>`, value: u.id }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={m.orgs_pick_user()} />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name} &lt;{u.email}&gt;
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <RoleSelect value={role} onChange={setRole} canGrantOwner />
              <Button
                disabled={!userId || action.pending}
                onClick={() =>
                  run(async () => {
                    await client.organizations.addMember({
                      organizationId: organization.id,
                      userId,
                      role,
                    });
                    setUserId("");
                  })
                }
              >
                {action.pending ? <Spinner /> : null}
                {m.orgs_add()}
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setInviteOpen(true)}>
            <HugeiconsIcon icon={UserAdd01Icon} strokeWidth={2} />
            {m.members_invite()}
          </Button>
          <Button onClick={onClose}>{m.common_close()}</Button>
        </DialogFooter>
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          canGrantOwner
          submit={(input) =>
            client.organizations.invite({ organizationId: organization.id, ...input })
          }
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The actions menu of a user. A component of its own so that the table's cell
 * renderers keep their identity: a new renderer per render would remount the
 * cell and close an open menu whenever the page re-renders.
 */
function UserActions({ user, onAddToOrg }: { user: User; onAddToOrg: (user: User) => void }) {
  const queryClient = useQueryClient();
  const setAdmin = useMutation(orpc.users.setAdmin.mutationOptions());
  const setDisabled = useMutation(orpc.users.setDisabled.mutationOptions());
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast.success(m.common_saved());
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={m.common_actions()}
            data-testid="user-actions"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onAddToOrg(user)}>{m.orgs_add_to_org()}</DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => run(() => setAdmin.mutateAsync({ id: user.id, isAdmin: !user.isAdmin }))}
        >
          {user.isAdmin ? m.users_revoke_admin() : m.users_grant_admin()}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant={user.disabled ? "default" : "destructive"}
          onClick={() =>
            run(() => setDisabled.mutateAsync({ id: user.id, disabled: !user.disabled }))
          }
        >
          {user.disabled ? m.users_enable() : m.users_disable()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsersTab() {
  const { me } = Route.useRouteContext();
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const users = useQuery(orpc.users.list.queryOptions({ input: { search: query || undefined } }));
  const [addTo, setAddTo] = React.useState<User | null>(null);
  const columns = React.useMemo<Columns<User>>(
    () => [
      {
        id: "name",
        header: () => m.users_col_user(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium" data-testid="user-name">
              {row.original.name}
            </span>
            <span className="text-xs text-muted-foreground">{row.original.email}</span>
          </div>
        ),
      },
      {
        id: "orgs",
        header: () => m.orgs_tab(),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.memberships.map((ms) => (
              <Badge key={ms.organizationId} variant="outline">
                {ms.organizationName} · {roleLabel(ms.role)}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: "status",
        header: () => m.nodes_col_status(),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.isAdmin ? <Badge>{m.users_admin()}</Badge> : null}
            {row.original.disabled ? (
              <Badge variant="destructive">{m.users_disabled()}</Badge>
            ) : null}
            {row.original.twoFactorEnabled ? (
              <Badge variant="secondary">{m.members_2fa_on()}</Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: "created",
        header: () => m.members_col_joined(),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{timeAgo(row.original.createdAt)}</span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) =>
          row.original.id === me.user.id ? null : (
            <div className="flex justify-end">
              <UserActions user={row.original} onAddToOrg={setAddTo} />
            </div>
          ),
      },
    ],
    [me.user.id],
  );
  return (
    <>
      <Input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={m.users_search_placeholder()}
        aria-label={m.users_search_placeholder()}
        className="w-full sm:w-72"
      />
      {users.isPending ? (
        <LoadingState />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      ) : users.data.length === 0 ? (
        <EmptyState icon={UserIcon} title={m.users_empty()} />
      ) : (
        <DataTable
          data={users.data}
          columns={columns}
          getRowId={(u) => u.id}
          testId="users-table"
        />
      )}
      {addTo ? <AddToOrgDialog user={addTo} onClose={() => setAddTo(null)} /> : null}
    </>
  );
}

function OrgSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const orgs = useQuery(orpc.organizations.list.queryOptions());
  const items = [
    { label: m.users_no_org(), value: NONE },
    ...(orgs.data ?? []).map((o) => ({ label: o.name, value: o.id })),
  ];
  return (
    <Select
      value={value || NONE}
      onValueChange={(v) => onChange(!v || v === NONE ? "" : String(v))}
      items={items}
    >
      <SelectTrigger className="w-full" data-testid="org-select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AddToOrgDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [organizationId, setOrganizationId] = React.useState("");
  const [role, setRole] = React.useState<OrgRole>("member");
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.orgs_add_to_org()}
      submitLabel={m.orgs_add()}
      onSubmit={async () => {
        await client.organizations.addMember({ organizationId, userId: user.id, role });
        await queryClient.invalidateQueries();
        onClose();
      }}
    >
      <Field>
        <FieldLabel>{m.orgs_tab()}</FieldLabel>
        <OrgSelect value={organizationId} onChange={setOrganizationId} />
      </Field>
      <Field>
        <FieldLabel>{m.members_col_role()}</FieldLabel>
        <RoleSelect value={role} onChange={setRole} canGrantOwner />
      </Field>
    </FormDialog>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.users.create.mutationOptions());
  const [isAdmin, setIsAdmin] = React.useState(false);
  const [organizationId, setOrganizationId] = React.useState("");
  const [role, setRole] = React.useState<OrgRole>("member");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.users_create()}
      submitLabel={m.common_create()}
      submitTestId="user-submit"
      onSubmit={async (data) => {
        await create.mutateAsync({
          name: String(data.get("userName") ?? "").trim(),
          email: String(data.get("userEmail") ?? "").trim(),
          password: String(data.get("userPassword") ?? ""),
          isAdmin,
          organizationId: organizationId || undefined,
          role,
        });
        await queryClient.invalidateQueries();
        toast.success(m.common_saved());
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="userName">{m.setup_name()}</FieldLabel>
        <Input id="userName" name="userName" required maxLength={100} autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="userEmail">{m.members_col_email()}</FieldLabel>
        <Input id="userEmail" name="userEmail" type="email" required autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="userPassword">{m.setup_password()}</FieldLabel>
        <Input
          id="userPassword"
          name="userPassword"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          placeholder={m.setup_password_placeholder()}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field>
          <FieldLabel>{m.orgs_tab()}</FieldLabel>
          <OrgSelect value={organizationId} onChange={setOrganizationId} />
        </Field>
        <Field>
          <FieldLabel>{m.members_col_role()}</FieldLabel>
          <RoleSelect value={role} onChange={setRole} canGrantOwner disabled={!organizationId} />
        </Field>
      </div>
      <Field orientation="horizontal">
        <Switch id="userIsAdmin" checked={isAdmin} onCheckedChange={setIsAdmin} />
        <FieldLabel htmlFor="userIsAdmin">{m.users_admin()}</FieldLabel>
      </Field>
    </FormDialog>
  );
}
