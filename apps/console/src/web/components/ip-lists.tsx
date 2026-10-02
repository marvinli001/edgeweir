import { type IpListDto, ipListInput } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";

export function IpListsPage() {
  const query = useQuery(orpc.ipLists.list.queryOptions());
  const api = client.ipLists;
  const queries = useQueryClient();
  const [editing, setEditing] = React.useState<IpListDto | "new" | null>(null);
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api.delete({ id });
      await queries.invalidateQueries();
    },
  });
  return (
    <Page
      title={m.ip_lists_title()}
      actions={
        <Button onClick={() => setEditing("new")} data-testid="ip-list-create">
          {m.ip_lists_create()}
        </Button>
      }
    >
      {query.isPending ? (
        <LoadingState />
      ) : query.isLoadingError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <EmptyState title={m.ip_lists_empty()} />
      ) : (
        <div className="grid gap-4">
          {query.data.map((list) => (
            <Card key={list.id} className="animate-enter">
              <CardContent className="flex flex-wrap items-center gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 break-all font-mono text-sm">
                    {`$${list.name}`}
                    {list.kind === "collection" ? null : (
                      <Badge variant="secondary" className="font-sans">
                        {list.kind === "allow" ? m.rules_allow() : m.rules_block()}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {m.ip_lists_count({ count: list.entries.length })}
                  </p>
                </div>
                <Button variant="outline" onClick={() => setEditing(list)}>
                  {m.common_edit()}
                </Button>
                <ConfirmDialog
                  title={m.common_delete()}
                  trigger={<Button variant="destructive">{m.common_delete()}</Button>}
                  destructive
                  onConfirm={() => remove.mutateAsync(list.id)}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing ? (
        <IpListDialog
          key={editing === "new" ? "new" : editing.id}
          list={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            if (editing === "new") await api.create(input);
            else await api.update({ id: editing.id, entries: input.entries, kind: input.kind });
            await queries.invalidateQueries();
            toast.success(m.common_saved());
            setEditing(null);
          }}
        />
      ) : null}
    </Page>
  );
}
function IpListDialog({
  list,
  onClose,
  onSave,
}: {
  list?: IpListDto;
  onClose: () => void;
  onSave: (input: ReturnType<typeof ipListInput.parse>) => Promise<void>;
}) {
  const [kind, setKind] = React.useState(list?.kind ?? "collection");
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={list ? m.common_edit() : m.ip_lists_create()}
      submitLabel={m.common_save()}
      submitTestId="ip-list-submit"
      onSubmit={async (data) =>
        onSave(
          ipListInput.parse({
            name: list?.name ?? data.get("name"),
            entries: String(data.get("entries") ?? "")
              .split(/[\s,]+/)
              .filter(Boolean),
            kind,
          }),
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="ip-list-name">{m.rules_name()}</FieldLabel>
        <Input
          id="ip-list-name"
          name="name"
          required
          defaultValue={list?.name}
          disabled={!!list}
          pattern="[a-zA-Z_][a-zA-Z0-9_]{0,63}"
        />
      </Field>
      <FormSelect
        id="ip-list-kind"
        label={m.rules_action()}
        value={kind}
        onChange={(v) => setKind(v as typeof kind)}
        options={[
          { value: "collection", label: m.ip_lists_collection() },
          { value: "block", label: m.rules_block() },
          { value: "allow", label: m.rules_allow() },
        ]}
      />
      <Field>
        <FieldLabel htmlFor="ip-list-entries">{m.ip_lists_entries()}</FieldLabel>
        <Textarea
          id="ip-list-entries"
          name="entries"
          rows={8}
          defaultValue={list?.entries.join("\n")}
          className="font-mono"
        />
      </Field>
    </FormDialog>
  );
}
