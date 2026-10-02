import type { Cluster, EnrollmentTokenResult } from "@edgeweir/contract";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Countdown } from "@/components/appica/countdown";
import { CodeBlock } from "@/components/copy-button";
import { OptionSelect } from "@/components/form-select";
import {
  ConsoleUrlWarnings,
  EnrollProgress,
  NodeChannelCheckStatus,
} from "@/components/node-enrollment";
import { SafetyNote } from "@/components/safety-note";
import { LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useOpenKey } from "@/hooks/use-open-key";
import { formatDateTime, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** The add-node dialog, fresh on every opening. */
export function EnrollDialogHost({
  cluster,
  open,
  onOpenChange,
}: {
  cluster: Cluster;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const key = useOpenKey(open);
  return (
    <EnrollDialog
      key={`${cluster.id}-${key}`}
      cluster={cluster}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

const TTL_OPTIONS = [15, 60, 24 * 60];

/**
 * Adding a node: the install command of a token minted with the defaults as
 * soon as the dialog opens, then the node's progress. Name, node group (with
 * more than one) and lifetime are options that mint another token.
 */
function EnrollDialog({
  cluster,
  open,
  onOpenChange,
}: {
  cluster: Cluster;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [ttl, setTtl] = React.useState(60);
  const [groupId, setGroupId] = React.useState<string>("");
  const [nodeName, setNodeName] = React.useState("");
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const [result, setResult] = React.useState<EnrollmentTokenResult | null>(null);
  const groups = useQuery({
    ...orpc.nodeGroups.list.queryOptions({ input: { clusterId: cluster.id } }),
    enabled: open,
  });
  const create = useMutation(orpc.clusters.createEnrollmentToken.mutationOptions());
  const { mutateAsync } = create;
  // One token per opening (the dialog is keyed per opening). StrictMode runs
  // effects twice; the ref keeps that to one token.
  const minted = React.useRef(false);
  // The command is the dialog's content: focus rests on closing, not on the options.
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open || minted.current) return;
    minted.current = true;
    mutateAsync({ clusterId: cluster.id }).then(setResult, () => {
      // rendered below via create.error
    });
  }, [open, cluster.id, mutateAsync]);
  const ttlLabel = (minutes: number) =>
    minutes < 60
      ? m.enroll_ttl_minutes({ count: minutes })
      : m.enroll_ttl_hours({ count: minutes / 60 });
  const groupOptions = (groups.data ?? []).map((g) => ({ label: g.name, value: g.id }));
  const selectedGroup = groupId || groups.data?.find((g) => g.isDefault)?.id || "";
  // Closing forgets the token: it is shown once.
  const setOpen = (next: boolean) => {
    if (!next) {
      setResult(null);
      create.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        initialFocus={closeRef}
      >
        <DialogHeader>
          <DialogTitle>{m.enroll_title()}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {result ? (
            <FieldGroup className="animate-enter">
              <Field>
                <FieldLabel>{m.enroll_command()}</FieldLabel>
                <CodeBlock value={result.installCommand} testId="install-command" />
                {/* The countdown renders a <div>, which a SafetyNote <p> cannot hold. */}
                <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  <span title={formatDateTime(result.expiresAt)}>{m.enroll_expires_in()}</span>
                  <Countdown target={result.expiresAt} className="text-foreground" />
                  <span aria-hidden="true">·</span>
                  <SafetyNote data-testid="enroll-token-once">{m.enroll_shown_once()}</SafetyNote>
                </div>
                <div className="flex flex-col gap-1">
                  <ConsoleUrlWarnings warnings={result.warnings} />
                  <NodeChannelCheckStatus line />
                </div>
              </Field>
              <Field>
                <FieldLabel>{m.enroll_progress()}</FieldLabel>
                <EnrollProgress key={result.tokenId} result={result} />
              </Field>
            </FieldGroup>
          ) : create.isPending ? (
            <LoadingState />
          ) : null}
          {create.isError && !optionsOpen ? (
            <FieldError>{errorMessage(create.error)}</FieldError>
          ) : null}
          {optionsOpen ? (
            <form
              className="animate-enter rounded-xl border p-3"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  setResult(
                    await create.mutateAsync({
                      clusterId: cluster.id,
                      nodeGroupId: selectedGroup || undefined,
                      nodeName: nodeName.trim(),
                      ttlMinutes: ttl,
                    }),
                  );
                  setOptionsOpen(false);
                } catch {
                  // rendered below via create.error
                }
              }}
            >
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="enrollNodeName">{m.enroll_node_name()}</FieldLabel>
                    {/* Not "nodeName": that would clobber HTMLFormElement.nodeName and break React events. */}
                    <Input
                      id="enrollNodeName"
                      name="enrollNodeName"
                      maxLength={64}
                      placeholder="edge-sh-01"
                      value={nodeName}
                      onChange={(event) => setNodeName(event.target.value)}
                    />
                  </Field>
                  {groupOptions.length > 1 ? (
                    <Field>
                      <FieldLabel>{m.nodes_col_group()}</FieldLabel>
                      <OptionSelect
                        value={selectedGroup}
                        options={groupOptions}
                        onChange={setGroupId}
                        testId="enroll-group"
                      />
                    </Field>
                  ) : null}
                  <Field>
                    <FieldLabel>{m.enroll_ttl()}</FieldLabel>
                    <OptionSelect
                      value={String(ttl)}
                      options={TTL_OPTIONS.map((v) => ({ label: ttlLabel(v), value: String(v) }))}
                      onChange={(value) => setTtl(Number(value))}
                    />
                  </Field>
                </div>
                {create.isError ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={create.isPending}
                    data-testid="generate-install-command"
                  >
                    {create.isPending ? <Spinner /> : null}
                    {m.enroll_generate()}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((value) => !value)}
            data-testid="enroll-options"
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={cn("transition-transform", optionsOpen && "rotate-180")}
            />
            {m.enroll_options()}
          </Button>
          <Button ref={closeRef} onClick={() => setOpen(false)} data-testid="enroll-close">
            {m.common_close()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
