import type { InvitationResult, OrgRole } from "@edgeweir/contract";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { CodeBlock } from "@/components/copy-button";
import { FormDialog } from "@/components/form-dialog";
import { SafetyNote } from "@/components/safety-note";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/lib/i18n";

export function roleLabel(role: OrgRole): string {
  return role === "owner" ? m.role_owner() : role === "admin" ? m.role_admin() : m.role_member();
}

export const ROLES: OrgRole[] = ["member", "admin", "owner"];

/** Role picker; owners can only be granted by owners (the server enforces it too). */
export function RoleSelect({
  value,
  onChange,
  canGrantOwner,
  disabled,
  testId,
  name,
}: {
  value: OrgRole;
  onChange?: (role: OrgRole) => void;
  canGrantOwner: boolean;
  disabled?: boolean;
  testId?: string;
  name?: string;
}) {
  const roles = ROLES.filter((r) => r !== "owner" || canGrantOwner || value === "owner");
  return (
    <Select
      name={name}
      value={value}
      disabled={disabled}
      onValueChange={(v) => v && onChange?.(v as OrgRole)}
      items={roles.map((r) => ({ label: roleLabel(r), value: r }))}
    >
      <SelectTrigger className="w-32" aria-label={m.members_col_role()} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((r) => (
          <SelectItem key={r} value={r}>
            {roleLabel(r)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function invitationLink(id: string): string {
  return `${window.location.origin}/invite/${id}`;
}

/** Invite dialog: shared by the console (own organization) and the admin area (any organization). */
export function InviteDialog({
  open,
  onOpenChange,
  canGrantOwner,
  submit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canGrantOwner: boolean;
  submit: (input: { email: string; role: OrgRole }) => Promise<InvitationResult>;
}) {
  const queryClient = useQueryClient();
  const [role, setRole] = React.useState<OrgRole>("member");
  const [result, setResult] = React.useState<InvitationResult | null>(null);
  const close = (next: boolean) => {
    if (!next) {
      setResult(null);
      setRole("member");
    }
    onOpenChange(next);
  };

  if (result) {
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={m.members_invite()}
        submitLabel={m.common_close()}
        onSubmit={async () => close(false)}
      >
        <Field>
          <FieldLabel>{m.members_invite_link()}</FieldLabel>
          <CodeBlock value={invitationLink(result.invitation.id)} testId="invite-link" />
          <SafetyNote>{result.invitation.email}</SafetyNote>
        </Field>
      </FormDialog>
    );
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={m.members_invite()}
      submitLabel={m.members_invite_submit()}
      submitTestId="invite-submit"
      onSubmit={async (data) => {
        const input = { email: String(data.get("inviteEmail") ?? "").trim(), role };
        const created = await submit(input);
        await queryClient.invalidateQueries();
        setResult(created);
      }}
    >
      <Field>
        <FieldLabel htmlFor="inviteEmail">{m.members_col_email()}</FieldLabel>
        <Input
          id="inviteEmail"
          name="inviteEmail"
          type="email"
          required
          placeholder="name@example.com"
        />
      </Field>
      <Field>
        <FieldLabel>{m.members_col_role()}</FieldLabel>
        <RoleSelect value={role} onChange={setRole} canGrantOwner={canGrantOwner} />
      </Field>
    </FormDialog>
  );
}
