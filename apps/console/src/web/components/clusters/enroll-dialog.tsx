import type { Cluster, EnrollmentTokenResult } from "@edgeweir/contract";
import { ArrowDown01Icon, CloudServerIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { CodeBlock } from "@/components/copy-button";
import { Countdown } from "@/components/countdown";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/layout/form";
import { Spinner } from "@/components/layout/spinner";
import {
  ConsoleUrlWarnings,
  EnrollProgress,
  NodeChannelCheckStatus,
} from "@/components/node-enrollment";
import { SafetyNote } from "@/components/safety-note";
import { LoadingState } from "@/components/states";
import { useOpenKey } from "@/hooks/use-open-key";
import { formatDateTime, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";
import { SshInstall } from "./ssh-install";

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

type Method = "ssh" | "manual";
const METHOD_KEY = "edgeweir.enroll-method";

/** The way nodes were added last time (SSH unless the manual command was chosen). */
function readMethod(): Method {
  try {
    return localStorage.getItem(METHOD_KEY) === "manual" ? "manual" : "ssh";
  } catch {
    return "ssh";
  }
}

function writeMethod(method: Method) {
  try {
    localStorage.setItem(METHOD_KEY, method);
  } catch {
    // private mode: the choice is not remembered
  }
}

/**
 * The cluster and the node being added, joined by a dashed line while the token waits and a
 * solid one once the node is online. Reads the token status EnrollProgress polls (same query, no
 * fetch of its own). Decorative: the progress list says the same in words.
 */
function EnrollLink({ cluster, tokenId }: { cluster: Cluster; tokenId: string }) {
  const status = useQuery({
    ...orpc.clusters.getEnrollmentToken.queryOptions({ input: { id: tokenId } }),
    enabled: false,
  });
  const node = status.data?.node ?? null;
  const online = !!node?.online;
  return (
    <div
      aria-hidden
      className="flex items-center gap-3 rounded-md px-5 py-4 faint-well animate-enter sm:px-10"
    >
      <div className="flex min-w-0 items-center gap-2 rounded-md border bg-card py-2 pr-3 pl-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground [&_svg]:size-3.5">
          <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
        </span>
        <span className="truncate text-xs font-medium">{cluster.name}</span>
      </div>
      <span
        className={cn(
          "min-w-8 flex-1 transition-colors duration-300",
          online ? "h-0.5 rounded-full bg-primary" : "border-t-2 border-dashed",
        )}
      />
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-md p-2 transition-colors duration-300",
          node ? "border bg-card pr-3" : "border border-dashed border-input-hover",
        )}
      >
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-3.5",
            online ? "bg-primary/12 text-primary" : "bg-wash text-muted-foreground",
          )}
        >
          <HugeiconsIcon icon={CloudServerIcon} strokeWidth={2} />
        </span>
        {node ? <span className="truncate text-xs font-medium">{node.name}</span> : null}
      </div>
    </div>
  );
}

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
  const [method, setMethod] = React.useState<Method>(readMethod);
  const groups = useQuery({
    ...orpc.nodeGroups.list.queryOptions({ input: { clusterId: cluster.id } }),
    enabled: open,
  });
  const create = useMutation(orpc.clusters.createEnrollmentToken.mutationOptions());
  const { mutateAsync } = create;
  // What the shown command was minted with: switching the node channel URL mints it again.
  const minting = React.useRef<Parameters<typeof mutateAsync>[0]>({ clusterId: cluster.id });
  // One token per opening (the dialog is keyed per opening). StrictMode runs
  // effects twice; the ref keeps that to one token.
  const minted = React.useRef(false);
  // The command is the dialog's content: focus rests on closing, not on the options.
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open || method !== "manual" || minted.current) return;
    minted.current = true;
    mutateAsync({ clusterId: cluster.id }).then(setResult, () => {
      // rendered below via create.error
    });
  }, [open, method, cluster.id, mutateAsync]);
  const ttlLabel = (minutes: number) =>
    minutes < 60
      ? m.enroll_ttl_minutes({ count: minutes })
      : m.enroll_ttl_hours({ count: minutes / 60 });
  const groupOptions = (groups.data ?? []).map((g) => ({ label: g.name, value: g.id }));
  const selectedGroup = groupId || groups.data?.find((g) => g.isDefault)?.id || "";
  // The token is shown once: forgotten once the dialog has closed (clearing it on the click
  // would leave an empty dialog on screen until the closing navigation and animation end).
  const forget = (isOpen: boolean) => {
    if (isOpen) return;
    setResult(null);
    create.reset();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={forget}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        initialFocus={method === "manual" ? closeRef : undefined}
      >
        <DialogHeader>
          <DialogTitle>{m.enroll_title()}</DialogTitle>
        </DialogHeader>
        <Tabs
          value={method}
          onValueChange={(value) => {
            setMethod(value as Method);
            writeMethod(value as Method);
          }}
        >
          <TabsList>
            <TabsTrigger value="ssh" data-testid="enroll-method-ssh">
              {m.enroll_method_ssh()}
            </TabsTrigger>
            <TabsTrigger value="manual" data-testid="enroll-method-manual">
              {m.enroll_method_manual()}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {method === "ssh" ? (
          <SshInstall cluster={cluster} onClose={() => onOpenChange(false)} />
        ) : (
          <>
            <div className="flex flex-col gap-4">
              {result ? (
                <FieldGroup className="animate-enter">
                  <EnrollLink cluster={cluster} tokenId={result.tokenId} />
                  <Field>
                    <FieldLabel>{m.enroll_command()}</FieldLabel>
                    <CodeBlock value={result.installCommand} testId="install-command" />
                    {/* The countdown renders a <div>, which a SafetyNote <p> cannot hold. */}
                    <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      <span title={formatDateTime(result.expiresAt)}>{m.enroll_expires_in()}</span>
                      <Countdown target={result.expiresAt} className="text-foreground" />
                      <span aria-hidden="true">·</span>
                      <SafetyNote data-testid="enroll-token-once">
                        {m.enroll_shown_once()}
                      </SafetyNote>
                    </div>
                    <div className="flex flex-col gap-1">
                      <ConsoleUrlWarnings warnings={result.warnings} />
                      <NodeChannelCheckStatus
                        line
                        onSwitched={() =>
                          mutateAsync(minting.current).then(setResult, () => {
                            // rendered below via create.error
                          })
                        }
                      />
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
                  className="animate-enter border-t pt-4"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    try {
                      minting.current = {
                        clusterId: cluster.id,
                        nodeGroupId: selectedGroup || undefined,
                        nodeName: nodeName.trim(),
                        ttlMinutes: ttl,
                      };
                      setResult(await create.mutateAsync(minting.current));
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
                          options={TTL_OPTIONS.map((v) => ({
                            label: ttlLabel(v),
                            value: String(v),
                          }))}
                          onChange={(value) => setTtl(Number(value))}
                        />
                      </Field>
                    </div>
                    {create.isError ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        variant="secondary"
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
              <Button ref={closeRef} onClick={() => onOpenChange(false)} data-testid="enroll-close">
                {m.common_close()}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
