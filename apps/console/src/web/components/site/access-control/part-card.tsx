import {
  type AccessControlPart,
  type AccessControlSettings,
  type FeatureAvailability,
  type SiteAccessControl,
  siteAccessControlUpdate,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { enterDelay } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

export type PartValue<P extends AccessControlPart> = AccessControlSettings[P];

/** Why a save failed, and the field of the part (and item of a list) it points at. */
export interface PartError {
  message: string;
  field?: string;
  item?: number;
}

/** What a card's fields render from. */
export interface PartFields<D> {
  draft: D;
  /** Changes fields of the draft (and clears the last error). */
  set: (change: Partial<D>) => void;
  /** The cluster's nodes cannot turn the part on yet and it is off: its fields wait. */
  blocked: boolean;
  /** Whether the last error points at this field (and item) of the part. */
  invalid: (field: string, item?: number) => boolean;
}

/** A site's access control: one query that every card of the tab shares. */
export function useAccessControl(siteId: string) {
  return useQuery(orpc.accessControl.get.queryOptions({ input: { id: siteId } }));
}

type Issue = { path?: readonly PropertyKey[] };

/**
 * "Check “Allowed sources”, item 3" for a validation issue under the part (`[part, field, …]`, as
 * the browser's and the server's checks both report it); null when no segment has a label.
 */
function issueError(issue: Issue | undefined, labels: Record<string, () => string>) {
  const path = (issue?.path ?? []).slice(1);
  const field = typeof path[0] === "string" ? path[0] : undefined;
  const numbers = path.filter((segment): segment is number => typeof segment === "number");
  const item = numbers[0];
  const named = path.filter(
    (segment): segment is string => typeof segment === "string" && !!labels[segment],
  );
  const label = named.length ? labels[named[named.length - 1] as string] : undefined;
  if (!label) return null;
  const message =
    item === undefined
      ? m.common_check_field({ field: label() })
      : m.common_check_field_item({ field: label(), item: item + 1 });
  return { message, field, item };
}

/** An API or browser validation error as the card shows it. */
function partError(error: unknown, labels: Record<string, () => string>): PartError {
  const data = (error as { data?: { issues?: unknown } } | null)?.data;
  const issues = Array.isArray(data?.issues)
    ? data.issues
    : (error as { issues?: unknown } | null)?.issues;
  const pointed = Array.isArray(issues) ? issueError(issues[0] as Issue, labels) : null;
  return pointed ?? { message: localizeError(error) };
}

/**
 * The draft of one part. While the form is unchanged it follows the server; with unsaved changes it
 * keeps them, and `version` stays the part they started from (a save checks it is still the part
 * the server has). Drafts compare by what they save (`toPart`), so row keys and text formatting do
 * not count.
 */
function usePartDraft<V, D>(server: V, toDraft: (value: V) => D, toPart: (draft: D) => unknown) {
  const version = JSON.stringify(server);
  const [state, setState] = React.useState(() => {
    const draft = toDraft(server);
    return { version, base: draft, draft };
  });
  const same = (a: D, b: D) => JSON.stringify(toPart(a)) === JSON.stringify(toPart(b));
  let current = state;
  if (version !== state.version && same(state.draft, state.base)) {
    const draft = toDraft(server);
    current = { version, base: draft, draft };
    setState(current);
  }
  const setDraft = React.useCallback((draft: D) => setState((s) => ({ ...s, draft })), []);
  return {
    draft: current.draft,
    setDraft,
    dirty: !same(current.draft, current.base),
    version: current.version,
  };
}

/** The save running or waiting per site, so saves of one site's parts go one after another. */
const turns = new Map<string, Promise<unknown>>();

/**
 * Runs `task` once the site's earlier saves are done. Each save sends the time the one before it
 * left (expectedUpdatedAt), so two cards saved at once do not refuse each other.
 */
function inTurn<T>(siteId: string, task: () => Promise<T>): Promise<T> {
  const run = (turns.get(siteId) ?? Promise.resolve()).then(task);
  turns.set(
    siteId,
    run.catch(() => undefined),
  );
  return run;
}

interface PartCardProps<P extends AccessControlPart, D> {
  siteId: string;
  part: P;
  title: string;
  /** Test ids: `${testId}-card`, `${testId}-save`, `${testId}-error`, `${testId}-unavailable`. */
  testId: string;
  /** The card's place on the tab, for the entrance stagger. */
  index: number;
  /** The form state of the saved part (numbers and lists may stay text while editing). */
  toDraft: (value: PartValue<P>) => D;
  /** What saving the draft sends as the part (validated by the contract first). */
  toPart: (draft: D) => unknown;
  /** Whether the part does anything (the nodes need access-control-v1 for it). */
  inUse: (value: PartValue<P>) => boolean;
  /** Labels of the part's fields, by their name in the contract, for errors that point at one. */
  labels: Record<string, () => string>;
  /** A check the API makes that the contract's schema does not, on the parsed part. */
  check?: (value: PartValue<P>) => PartError | null;
  contentClassName?: string;
  children: (fields: PartFields<D>) => React.ReactNode;
}

/**
 * One part of a site's access control in a card of its own: it saves only that part (PATCH) with
 * the settings' last read time, so cards never undo each other. When the cluster's nodes lack
 * access-control-v1 the card says so; a part that is off then cannot be turned on, one that is on
 * can still be edited or turned off.
 */
export function AccessPartCard<P extends AccessControlPart, D>({
  siteId,
  title,
  testId,
  index,
  ...form
}: PartCardProps<P, D>) {
  const settings = useAccessControl(siteId);
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  // Bumped by every save, so the form starts over from what was saved.
  const [saves, setSaves] = React.useState(0);
  return (
    <Card className="animate-enter" style={enterDelay(index + 1)} data-testid={`${testId}-card`}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <QueryView query={combineQueries(settings, features)} frame={CardContent}>
        {([data, available]) => (
          <PartForm
            key={saves}
            {...form}
            siteId={siteId}
            testId={testId}
            data={data}
            availability={available.accessControl}
            onSaved={() => setSaves((n) => n + 1)}
          />
        )}
      </QueryView>
    </Card>
  );
}

function PartForm<P extends AccessControlPart, D>({
  siteId,
  part,
  testId,
  data,
  availability,
  toDraft,
  toPart,
  inUse,
  labels,
  check,
  contentClassName,
  children,
  onSaved,
}: Omit<PartCardProps<P, D>, "title" | "index"> & {
  data: SiteAccessControl;
  availability: FeatureAvailability;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.accessControl.update.mutationOptions());
  const server = data[part];
  const { draft, setDraft, dirty, version } = usePartDraft(server, toDraft, toPart);
  const [error, setError] = React.useState<PartError | null>(null);
  const [saving, setSaving] = React.useState(false);
  const blocked = !availability.available && !inUse(server);
  const fields: PartFields<D> = {
    draft,
    set: (change) => {
      setDraft({ ...draft, ...change });
      setError(null);
    },
    blocked,
    invalid: (field, item) => error?.field === field && (item === undefined || error.item === item),
  };
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const parsed = siteAccessControlUpdate.safeParse({ id: siteId, [part]: toPart(draft) });
        if (!parsed.success) {
          setError(partError(parsed.error, labels));
          return;
        }
        const refused = check?.(parsed.data[part] as PartValue<P>);
        if (refused) {
          setError(refused);
          return;
        }
        const key = orpc.accessControl.get.queryKey({ input: { id: siteId } });
        setSaving(true);
        try {
          await inTurn(siteId, async () => {
            // The settings as the last read or save left them.
            const latest = queryClient.getQueryData<SiteAccessControl>(key) ?? data;
            // Someone saved this part since the form was filled: saving would undo their change.
            if (JSON.stringify(latest[part]) !== version)
              throw Object.assign(new Error("changed"), { code: "UPDATED_AT_MISMATCH" });
            const saved = await mutation.mutateAsync({
              ...parsed.data,
              ...(latest.updatedAt ? { expectedUpdatedAt: latest.updatedAt } : {}),
            });
            queryClient.setQueryData(key, saved);
          });
          // An IP check's verdict reads the site lists.
          void queryClient.invalidateQueries({ queryKey: orpc.ipCheck.key() });
          toast.success(m.common_saved());
          onSaved();
        } catch (err) {
          setError(partError(err, labels));
          setSaving(false);
        }
      }}
    >
      <CardContent className={cn("flex flex-col gap-5", contentClassName)}>
        {availability.available ? null : (
          <SafetyNote className="animate-in fade-in" data-testid={`${testId}-unavailable`}>
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        )}
        {children(fields)}
      </CardContent>
      <SaveBar
        dirty={dirty && !blocked}
        pending={saving}
        error={error?.message ?? null}
        testId={`${testId}-save`}
        errorTestId={`${testId}-error`}
      />
    </form>
  );
}
