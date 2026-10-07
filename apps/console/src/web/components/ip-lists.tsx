import { type IpListDto, ipListInput } from "@edgeweir/contract";
import { canonicalCidr } from "@edgeweir/rule-engine";
import { Add01Icon, ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { AccessTabs } from "@/components/access-tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { enterDelay, Page } from "@/components/page";
import { EmptyState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { formatNumber, m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";

/** Entries a list card shows in its well; a longer list ends with the count of the rest. */
const PREVIEW = 6;

/** An entry the contract accepts: an IP address or CIDR of at most 64 characters. */
function validEntry(entry: string) {
  try {
    canonicalCidr(entry);
    return entry.length <= 64;
  } catch {
    return false;
  }
}

export function IpListsPage() {
  const query = useQuery(orpc.ipLists.list.queryOptions());
  const api = client.ipLists;
  const queries = useQueryClient();
  const edit = useDialogState<IpListDto | "new">();
  const editing = edit.value;
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api.delete({ id });
      await queries.invalidateQueries();
    },
  });
  const createButton = (
    <Button onClick={() => edit.show("new")} data-testid="ip-list-create">
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {m.ip_lists_create()}
    </Button>
  );
  return (
    <Page title={m.ip_lists_title()} actions={createButton}>
      <AccessTabs value="ip-lists" />
      <QueryView
        query={query}
        empty={
          <EmptyState icon={ListViewIcon} art="checkpoint" title={m.ip_lists_empty()}>
            <Button onClick={() => edit.show("new")}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.ip_lists_create()}
            </Button>
          </EmptyState>
        }
      >
        {(lists) => (
          <div className="grid gap-4 @3xl/main:grid-cols-2">
            {lists.map((list, index) => (
              <IpListCard
                key={list.id}
                list={list}
                index={index}
                onEdit={() => edit.show(list)}
                onDelete={() => remove.mutateAsync(list.id)}
              />
            ))}
          </div>
        )}
      </QueryView>
      {editing ? (
        <IpListDialog
          key={edit.key}
          list={editing === "new" ? undefined : editing}
          open={edit.open}
          onOpenChange={edit.onOpenChange}
          onSave={async (input) => {
            if (editing === "new") await api.create(input);
            else await api.update({ id: editing.id, entries: input.entries, kind: input.kind });
            await queries.invalidateQueries();
            toast.success(m.common_saved());
            edit.onOpenChange(false);
          }}
        />
      ) : null}
    </Page>
  );
}

/**
 * One list: its `$name` (how expressions reference it), what it does on its own (block / allow)
 * and its size, then the first entries in a well, as the dialog will show them.
 */
function IpListCard({
  list,
  index,
  onEdit,
  onDelete,
}: {
  list: IpListDto;
  index: number;
  onEdit: () => void;
  onDelete: () => Promise<unknown>;
}) {
  const shown = list.entries.length > PREVIEW ? list.entries.slice(0, PREVIEW - 1) : list.entries;
  const rest = list.entries.length - shown.length;
  return (
    <Card size="sm" className="animate-enter" style={enterDelay(index)}>
      <CardHeader>
        <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-sm break-all">{`$${list.name}`}</span>
          {list.kind === "collection" ? null : (
            <Badge variant={list.kind === "block" ? "destructive" : "secondary"}>
              {list.kind === "allow" ? m.rules_allow() : m.rules_block()}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground tabular-nums">
          {m.ip_lists_count({ count: formatNumber(list.entries.length) })}
        </p>
        <CardAction className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>
            {m.common_edit()}
          </Button>
          <ConfirmDialog
            title={m.common_delete()}
            trigger={
              <Button size="sm" variant="destructive">
                {m.common_delete()}
              </Button>
            }
            destructive
            onConfirm={onDelete}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <ul className="flex flex-1 flex-wrap content-start gap-x-5 gap-y-1 rounded-xl px-3 py-2.5 font-mono text-xs sunk-well">
          {shown.map((entry) => (
            <li key={entry} className="max-w-full truncate" title={entry}>
              {entry}
            </li>
          ))}
          {rest > 0 ? (
            <li className="text-muted-foreground tabular-nums">{`+${formatNumber(rest)}`}</li>
          ) : null}
          {list.entries.length === 0 ? <li className="text-muted-foreground">—</li> : null}
        </ul>
      </CardContent>
    </Card>
  );
}

function IpListDialog({
  list,
  open,
  onOpenChange,
  onSave,
}: {
  list?: IpListDto;
  onSave: (input: ReturnType<typeof ipListInput.parse>) => Promise<void>;
} & DialogProps) {
  const [kind, setKind] = React.useState(list?.kind ?? "collection");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={list ? m.common_edit() : m.ip_lists_create()}
      submitLabel={m.common_save()}
      submitTestId="ip-list-submit"
      onSubmit={async (data) => {
        const entries = String(data.get("entries") ?? "")
          .split(/[\s,]+/)
          .filter(Boolean);
        const invalid = entries.find((entry) => !validEntry(entry));
        if (invalid !== undefined) throw new Error(m.ip_lists_invalid_entry({ entry: invalid }));
        const parsed = ipListInput.safeParse({
          name: list?.name ?? data.get("name"),
          entries,
          kind,
        });
        if (!parsed.success) throw new Error(m.error_bad_request());
        await onSave(parsed.data);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="ip-list-name">{m.rules_name()}</FieldLabel>
          <Input
            id="ip-list-name"
            name="name"
            required
            defaultValue={list?.name}
            disabled={!!list}
            pattern="[a-zA-Z_][a-zA-Z0-9_]{0,63}"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <FormSelect
          id="ip-list-kind"
          label={m.rules_action()}
          value={kind}
          onChange={setKind}
          options={[
            { value: "collection", label: m.ip_lists_collection() },
            { value: "block", label: m.rules_block() },
            { value: "allow", label: m.rules_allow() },
          ]}
        />
      </div>
      <Field>
        <FieldLabel htmlFor="ip-list-entries">{m.ip_lists_entries()}</FieldLabel>
        {/* Grows with its entries up to half the screen, then scrolls (lists hold thousands). */}
        <Textarea
          id="ip-list-entries"
          name="entries"
          rows={8}
          defaultValue={list?.entries.join("\n")}
          spellCheck={false}
          className="max-h-[50svh] min-h-40 overflow-y-auto font-mono"
        />
      </Field>
    </FormDialog>
  );
}
