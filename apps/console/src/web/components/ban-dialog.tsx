import {
  BAN_DURATIONS,
  type BanReason,
  type BanScope,
  MANUAL_BAN_REASONS,
} from "@edgeweir/contract";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { QueryView } from "@/components/states";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { DialogProps } from "@/hooks/use-dialog-state";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";

export const BAN_REASON_LABELS: Record<BanReason, () => string> = {
  abuse: () => m.bans_reason_abuse(),
  attack: () => m.bans_reason_attack(),
  scanner: () => m.bans_reason_scanner(),
  spam: () => m.bans_reason_spam(),
  other: () => m.bans_reason_other(),
  cc_ip_rate: () => m.bans_reason_cc_ip_rate(),
};

export const BAN_SCOPE_LABELS: Record<BanScope, () => string> = {
  platform: () => m.bans_scope_platform(),
  site: () => m.bans_scope_site(),
};

function durationLabel(seconds: number): string {
  return seconds % 86400 === 0
    ? m.bans_duration_days({ count: seconds / 86400 })
    : m.bans_duration_hours({ count: seconds / 3600 });
}

type SiteChoice = { id: string; name: string };

/** Sites the caller can ban in: a search box and a select over the matches. */
function SiteSelect({
  value,
  onChange,
}: {
  value: SiteChoice | null;
  onChange: (site: SiteChoice) => void;
}) {
  const [search, setSearch] = React.useState("");
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({
      input: { search: search.trim() || undefined, page: 1, pageSize: 100 },
    }),
    placeholderData: keepPreviousData,
  });
  const choices = (sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }));
  if (value && !choices.some((c) => c.value === value.id))
    choices.unshift({ value: value.id, label: value.name });
  return (
    <>
      <Field>
        <FieldLabel htmlFor="ban-site-search">{m.bans_site_search()}</FieldLabel>
        <Input
          id="ban-site-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Field>
      <QueryView query={sites} loadingClassName="min-h-16">
        {() => (
          <FormSelect
            id="ban-site"
            label={m.bans_site()}
            value={value?.id ?? ""}
            options={choices}
            onChange={(id) =>
              onChange({ id, name: choices.find((c) => c.value === id)?.label ?? "" })
            }
          />
        )}
      </QueryView>
    </>
  );
}

/**
 * A manual ban of an address on one site or on every site. Opened from a row it starts with the
 * row's address and site; the scope can still be switched.
 */
export function BanDialog({
  open,
  onOpenChange,
  address,
  siteId,
  scope: initialScope = "site",
}: {
  address?: string;
  siteId?: string;
  scope?: BanScope;
} & DialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [scope, setScope] = React.useState<BanScope>(initialScope);
  const initialSite = useQuery({
    ...orpc.sites.get.queryOptions({ input: { id: siteId ?? "" } }),
    enabled: !!siteId,
  });
  const [picked, setPicked] = React.useState<SiteChoice | null>(null);
  const site =
    picked ?? (initialSite.data ? { id: initialSite.data.id, name: initialSite.data.name } : null);
  const [reason, setReason] = React.useState<string>(MANUAL_BAN_REASONS[0]);
  const [duration, setDuration] = React.useState(String(24 * 3600));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.bans_create()}
      submitLabel={m.bans_submit()}
      submitTestId="ban-submit"
      onSubmit={async (data) => {
        const cidr = String(data.get("cidr") ?? "").trim();
        const fields = {
          cidr,
          reason: reason as (typeof MANUAL_BAN_REASONS)[number],
          durationSeconds: Number(duration),
        };
        if (scope === "site" && !site) throw new Error(m.bans_site_required());
        const ban = await client.bans.create(
          scope === "site" ? { ...fields, scope, siteId: site?.id } : { ...fields, scope },
        );
        await queryClient.invalidateQueries({ queryKey: orpc.bans.key() });
        toast.success(m.bans_created(), {
          action: {
            label: m.bans_view(),
            onClick: () =>
              void navigate({ to: "/bans", search: ban.siteId ? { site: ban.siteId } : {} }),
          },
        });
        onOpenChange(false);
      }}
    >
      <FormSelect
        id="ban-scope"
        label={m.bans_scope()}
        value={scope}
        options={(["site", "platform"] as const).map((value) => ({
          value,
          label: BAN_SCOPE_LABELS[value](),
        }))}
        onChange={(value) => setScope(value as BanScope)}
      />
      {scope === "site" ? <SiteSelect value={site} onChange={setPicked} /> : null}
      <Field>
        <FieldLabel htmlFor="ban-cidr">{m.bans_address()}</FieldLabel>
        <Input
          id="ban-cidr"
          name="cidr"
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder="203.0.113.7"
          defaultValue={address}
          data-testid="ban-cidr"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect
          id="ban-reason"
          label={m.bans_reason()}
          value={reason}
          options={MANUAL_BAN_REASONS.map((value) => ({
            value,
            label: BAN_REASON_LABELS[value](),
          }))}
          onChange={setReason}
        />
        <FormSelect
          id="ban-duration"
          label={m.bans_duration()}
          value={duration}
          options={BAN_DURATIONS.map((seconds) => ({
            value: String(seconds),
            label: durationLabel(seconds),
          }))}
          onChange={setDuration}
        />
      </div>
    </FormDialog>
  );
}
