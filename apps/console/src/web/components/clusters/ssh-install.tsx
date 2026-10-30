import {
  type Cluster,
  type HostKeyScan,
  isSshHost,
  isSshUsername,
  normalizeFingerprint,
  parseSshHostList,
  SSH_INSTALL_LIMITS,
  type SshCredential,
  type SshHostLine,
  type SshInstallError,
  type SshInstallHost,
} from "@edgeweir/contract";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { DialogFooter } from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import { Switch } from "@/components/arc/switch/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { Textarea } from "@/components/arc/textarea/textarea";
import { CodeBlock } from "@/components/copy-button";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/layout/form";
import { Spinner } from "@/components/layout/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { EnrollProgress } from "@/components/node-enrollment";
import { SafetyNote } from "@/components/safety-note";
import { Dot, type StatusTone } from "@/components/status-dot";
import { copyText } from "@/lib/browser";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Target = SshHostLine & { expected?: string };

const HOST_STATE: Record<SshInstallHost["state"], { tone: StatusTone; pulse?: boolean }> = {
  queued: { tone: "idle" },
  connecting: { tone: "idle", pulse: true },
  installing: { tone: "idle", pulse: true },
  succeeded: { tone: "good" },
  failed: { tone: "bad" },
  canceled: { tone: "warn" },
};

const stateText = (state: SshInstallHost["state"]) =>
  ({
    queued: m.ssh_state_queued,
    connecting: m.ssh_state_connecting,
    installing: m.ssh_state_installing,
    succeeded: m.ssh_state_succeeded,
    failed: m.ssh_state_failed,
    canceled: m.ssh_state_canceled,
  })[state]();

const sshErrorText = (error: SshInstallError) =>
  ({
    host_key_mismatch: m.ssh_install_error_host_key_mismatch,
    outbound_refused: m.ssh_install_error_outbound_refused,
    unreachable: m.ssh_install_error_unreachable,
    timeout: m.ssh_install_error_timeout,
    auth_failed: m.ssh_install_error_auth_failed,
    sudo_password_required: m.ssh_install_error_sudo_password_required,
    sudo_password_wrong: m.ssh_install_error_sudo_password_wrong,
    sudo_requires_tty: m.ssh_install_error_sudo_requires_tty,
    sudo_not_allowed: m.ssh_install_error_sudo_not_allowed,
    download_failed: m.ssh_install_error_download_failed,
    install_failed: m.ssh_install_error_install_failed,
    not_enrolled: m.ssh_install_error_not_enrolled,
    connection_lost: m.ssh_install_error_connection_lost,
    console_error: m.ssh_install_error_console_error,
    system_unsupported: m.ssh_install_error_system_unsupported,
    console_unreachable: m.ssh_install_error_console_unreachable,
    verify_failed: m.ssh_install_error_verify_failed,
    token_rejected: m.ssh_install_error_token_rejected,
    enrolled_elsewhere: m.ssh_install_error_enrolled_elsewhere,
    install_busy: m.ssh_install_error_install_busy,
    start_failed: m.ssh_install_error_start_failed,
    health_failed: m.ssh_install_error_health_failed,
  })[error]();

const stepText = (step: NonNullable<SshInstallHost["step"]>) =>
  ({
    check: m.ssh_step_check,
    download: m.ssh_step_download,
    verify: m.ssh_step_verify,
    install: m.ssh_step_install,
    enroll: m.ssh_step_enroll,
    start: m.ssh_step_start,
    health: m.ssh_step_health,
  })[step]();

const scanErrorText = (error: NonNullable<HostKeyScan["error"]>) =>
  ({
    unreachable: m.ssh_scan_error_unreachable,
    timeout: m.ssh_scan_error_timeout,
    not_ssh: m.ssh_scan_error_not_ssh,
    outbound_refused: m.ssh_scan_error_outbound_refused,
  })[error]();

const errorCode = (error: unknown) =>
  error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;

const hostLabel = (h: { host: string; port: number }) =>
  `${h.host.includes(":") ? `[${h.host}]` : h.host}${h.port === 22 ? "" : `:${h.port}`}`;

/**
 * Installing nodes over SSH (ADR-0066): the hosts and one credential, then the host keys to
 * confirm, then each host's progress. The credential stays in this form (for retries) until the
 * dialog closes; the console keeps it only while a run is going.
 */
export function SshInstall({ cluster, onClose }: { cluster: Cluster; onClose: () => void }) {
  const [step, setStep] = React.useState<"form" | "confirm" | "run">("form");
  const [batch, setBatch] = React.useState(false);
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState("22");
  const [username, setUsername] = React.useState("root");
  const [nodeName, setNodeName] = React.useState("");
  const [expected, setExpected] = React.useState("");
  const [list, setList] = React.useState("");
  const [auth, setAuth] = React.useState<"password" | "key">("password");
  const [password, setPassword] = React.useState("");
  const [privateKey, setPrivateKey] = React.useState("");
  const [passphrase, setPassphrase] = React.useState("");
  const [sudoPassword, setSudoPassword] = React.useState("");
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const [groupId, setGroupId] = React.useState("");
  const [version, setVersion] = React.useState("");
  const [format, setFormat] = React.useState<"auto" | "deb" | "rpm" | "tar">("auto");
  const [mirror, setMirror] = React.useState("");
  const [mirrorOnly, setMirrorOnly] = React.useState(false);
  const [modsecurity, setModsecurity] = React.useState(true);
  const [concurrency, setConcurrency] = React.useState(
    String(SSH_INSTALL_LIMITS.defaultConcurrency),
  );
  const [timeout, setTimeoutMinutes] = React.useState(
    String(SSH_INSTALL_LIMITS.defaultTimeoutMinutes),
  );
  const [formError, setFormError] = React.useState<string[]>([]);
  const [targets, setTargets] = React.useState<Target[]>([]);
  const [scans, setScans] = React.useState<HostKeyScan[]>([]);
  const [runId, setRunId] = React.useState<string | null>(null);

  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: { clusterId: cluster.id } }));
  const groupOptions = (groups.data ?? []).map((g) => ({ label: g.name, value: g.id }));
  const scan = useMutation(orpc.sshInstalls.scanHostKeys.mutationOptions());
  const start = useMutation(orpc.sshInstalls.start.mutationOptions());

  const credential = (): SshCredential => ({
    username: username.trim(),
    ...(auth === "password" ? { password } : { privateKey, ...(passphrase ? { passphrase } : {}) }),
    ...(sudoPassword ? { sudoPassword } : {}),
  });

  /** The hosts as entered, or the reasons they cannot be used. */
  const readTargets = (): { targets: Target[]; errors: string[] } => {
    const errors: string[] = [];
    let found: Target[] = [];
    if (batch) {
      const parsed = parseSshHostList(list);
      for (const error of parsed.errors.slice(0, 5))
        errors.push(m.ssh_line_invalid({ line: error.line, text: error.text.slice(0, 80) }));
      if (parsed.errors.length > 5)
        errors.push(m.ssh_lines_invalid_more({ count: parsed.errors.length - 5 }));
      found = parsed.hosts;
      if (found.length === 0 && parsed.errors.length === 0) errors.push(m.ssh_hosts_required());
    } else {
      const name = host
        .trim()
        .replace(/^\[(.*)\]$/, "$1")
        .toLowerCase();
      const portNumber = Number(port);
      if (!isSshHost(name)) errors.push(m.ssh_host_invalid());
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
        errors.push(m.ssh_port_invalid());
      const fingerprint = expected.trim() ? normalizeFingerprint(expected) : undefined;
      if (fingerprint === null) errors.push(m.ssh_fingerprint_invalid());
      found = [
        {
          host: name,
          port: portNumber,
          username: username.trim(),
          ...(nodeName.trim() ? { nodeName: nodeName.trim() } : {}),
          ...(fingerprint ? { expected: fingerprint } : {}),
        },
      ];
    }
    if (!isSshUsername(username.trim())) errors.push(m.ssh_user_invalid());
    if (found.length > SSH_INSTALL_LIMITS.hosts)
      errors.push(m.ssh_hosts_too_many({ limit: SSH_INSTALL_LIMITS.hosts }));
    const seen = new Set<string>();
    for (const t of found) {
      const key = `${t.host}:${t.port}`;
      if (seen.has(key)) errors.push(m.error_ssh_install_duplicate_host({ host: hostLabel(t) }));
      seen.add(key);
    }
    if (auth === "password" ? !password : !privateKey.trim())
      errors.push(m.ssh_credential_required());
    return { targets: found, errors };
  };

  const scanHosts = async (event: React.FormEvent) => {
    event.preventDefault();
    const read = readTargets();
    setFormError(read.errors);
    if (read.errors.length > 0) return;
    try {
      const result = await scan.mutateAsync({
        hosts: read.targets.map((t) => ({ host: t.host, port: t.port })),
      });
      setTargets(read.targets);
      setScans(result.hosts);
      setStep("confirm");
    } catch {
      // rendered below via scan.error
    }
  };

  const mismatch = (index: number) => {
    const want = targets[index]?.expected;
    const got = scans[index]?.fingerprint;
    return !!want && !!got && want !== got;
  };
  const installable = scans.flatMap((s, index) =>
    s.fingerprint && !mismatch(index) ? [{ scan: s, target: targets[index] as Target }] : [],
  );

  const install = async () => {
    try {
      const run = await start.mutateAsync({
        clusterId: cluster.id,
        nodeGroupId: groupId || undefined,
        credential: credential(),
        hosts: installable.map(({ scan: s, target }) => ({
          host: target.host,
          port: target.port,
          ...(target.username ? { username: target.username } : {}),
          nodeName: target.nodeName ?? "",
          hostKeyFingerprint: s.fingerprint ?? "",
        })),
        options: {
          version: version.trim(),
          format,
          mirror: mirror.trim(),
          mirrorOnly,
          modsecurity,
        },
        concurrency: Number(concurrency) || SSH_INSTALL_LIMITS.defaultConcurrency,
        timeoutMinutes: Number(timeout) || SSH_INSTALL_LIMITS.defaultTimeoutMinutes,
      });
      setRunId(run.id);
      setStep("run");
    } catch {
      // rendered below via start.error
    }
  };

  if (step === "run" && runId)
    return <RunView runId={runId} cluster={cluster} credential={credential} onClose={onClose} />;

  if (step === "confirm")
    return (
      <>
        <div className="flex flex-col gap-3 animate-enter">
          <div className="overflow-hidden rounded-lg border">
            <Table data-testid="ssh-host-keys">
              <TableHeader>
                <TableRow>
                  <TableHead>{m.ssh_host()}</TableHead>
                  <TableHead>{m.ssh_fingerprint()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scans.map((s, index) => (
                  <TableRow
                    key={`${s.host}:${s.port}`}
                    data-testid="ssh-host-key"
                    data-error={s.error ?? undefined}
                  >
                    <TableCell className="font-mono">{hostLabel(s)}</TableCell>
                    <TableCell className="min-w-0">
                      {s.fingerprint ? (
                        <span className="flex flex-col gap-0.5">
                          <span
                            className="font-mono text-xs break-all"
                            data-testid="ssh-fingerprint"
                          >
                            {s.fingerprint}
                          </span>
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {mismatch(index) ? (
                              <>
                                <Dot tone="bad" small />
                                {m.ssh_fingerprint_mismatch()}
                              </>
                            ) : (
                              s.algorithm
                            )}
                          </span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          <Dot tone="bad" small />
                          {scanErrorText(s.error ?? "unreachable")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <SafetyNote>{m.ssh_fingerprint_note()}</SafetyNote>
          {start.isError ? <FieldError>{errorMessage(start.error)}</FieldError> : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={() => setStep("form")} data-testid="ssh-back">
            {m.ssh_back()}
          </Button>
          <Button
            onClick={install}
            disabled={installable.length === 0 || start.isPending}
            data-testid="ssh-install-start"
          >
            {start.isPending ? <Spinner /> : null}
            {m.ssh_install_count({ count: installable.length })}
          </Button>
        </DialogFooter>
      </>
    );

  const showSudo = batch || username.trim() !== "root";
  return (
    <form onSubmit={scanHosts} className="contents" data-testid="ssh-install-form">
      <FieldGroup className="animate-enter">
        <Tabs value={batch ? "batch" : "single"} onValueChange={(v) => setBatch(v === "batch")}>
          <TabsList>
            <TabsTrigger value="single" data-testid="ssh-single">
              {m.ssh_target_single()}
            </TabsTrigger>
            <TabsTrigger value="batch" data-testid="ssh-batch">
              {m.ssh_target_batch()}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {batch ? (
          <>
            <Field>
              <FieldLabel htmlFor="sshHostList">{m.ssh_host_list()}</FieldLabel>
              <Textarea
                id="sshHostList"
                rows={6}
                className="font-mono text-xs"
                spellCheck={false}
                placeholder={m.ssh_host_list_placeholder()}
                value={list}
                onChange={(event) => setList(event.target.value)}
              />
            </Field>
            <Field className="sm:max-w-48">
              <FieldLabel htmlFor="sshUser">{m.ssh_user()}</FieldLabel>
              <Input
                id="sshUser"
                autoComplete="off"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_6rem_8rem]">
            <Field>
              <FieldLabel htmlFor="sshHost">{m.ssh_host()}</FieldLabel>
              <Input
                id="sshHost"
                autoComplete="off"
                spellCheck={false}
                placeholder="203.0.113.10"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sshPort">{m.ssh_port()}</FieldLabel>
              <Input
                id="sshPort"
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sshUser">{m.ssh_user()}</FieldLabel>
              <Input
                id="sshUser"
                autoComplete="off"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
          </div>
        )}
        <Tabs value={auth} onValueChange={(v) => setAuth(v as "password" | "key")}>
          <TabsList>
            <TabsTrigger value="password" data-testid="ssh-auth-password">
              {m.ssh_auth_password()}
            </TabsTrigger>
            <TabsTrigger value="key" data-testid="ssh-auth-key">
              {m.ssh_auth_key()}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {auth === "password" ? (
          <Field>
            <FieldLabel htmlFor="sshPassword">{m.ssh_password()}</FieldLabel>
            <Input
              id="sshPassword"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="sshPrivateKey">{m.ssh_private_key()}</FieldLabel>
              <Textarea
                id="sshPrivateKey"
                rows={4}
                className="font-mono text-xs"
                spellCheck={false}
                autoComplete="off"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sshPassphrase">{m.ssh_passphrase()}</FieldLabel>
              <Input
                id="sshPassphrase"
                type="password"
                autoComplete="off"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </Field>
          </>
        )}
        {showSudo ? (
          <Field>
            <FieldLabel htmlFor="sshSudoPassword">{m.ssh_sudo_password()}</FieldLabel>
            <Input
              id="sshSudoPassword"
              type="password"
              autoComplete="off"
              value={sudoPassword}
              onChange={(event) => setSudoPassword(event.target.value)}
            />
          </Field>
        ) : null}
        <SafetyNote data-testid="ssh-credentials-note">{m.ssh_credentials_note()}</SafetyNote>
        {optionsOpen ? (
          <div className="grid gap-4 border-t pt-4 animate-enter sm:grid-cols-2">
            {batch ? null : (
              <>
                <Field>
                  <FieldLabel htmlFor="sshNodeName">{m.enroll_node_name()}</FieldLabel>
                  <Input
                    id="sshNodeName"
                    maxLength={64}
                    placeholder="edge-sh-01"
                    value={nodeName}
                    onChange={(event) => setNodeName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sshExpected">{m.ssh_fingerprint_expected()}</FieldLabel>
                  <Input
                    id="sshExpected"
                    className="font-mono"
                    spellCheck={false}
                    placeholder="SHA256:"
                    value={expected}
                    onChange={(event) => setExpected(event.target.value)}
                  />
                </Field>
              </>
            )}
            {groupOptions.length > 1 ? (
              <Field>
                <FieldLabel>{m.nodes_col_group()}</FieldLabel>
                <OptionSelect
                  value={groupId || groups.data?.find((g) => g.isDefault)?.id || ""}
                  options={groupOptions}
                  onChange={setGroupId}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="sshVersion">{m.ssh_version()}</FieldLabel>
              <Input
                id="sshVersion"
                placeholder={m.ssh_version_latest()}
                value={version}
                onChange={(event) => setVersion(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>{m.ssh_format()}</FieldLabel>
              <OptionSelect
                value={format}
                options={[
                  { value: "auto", label: m.ssh_format_auto() },
                  { value: "deb", label: "deb" },
                  { value: "rpm", label: "rpm" },
                  { value: "tar", label: "tar.gz" },
                ]}
                onChange={setFormat}
              />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="sshMirror">{m.ssh_mirror()}</FieldLabel>
              <Input
                id="sshMirror"
                type="url"
                placeholder="https://"
                value={mirror}
                onChange={(event) => setMirror(event.target.value)}
              />
            </Field>
            {batch ? (
              <Field>
                <FieldLabel htmlFor="sshConcurrency">{m.ssh_concurrency()}</FieldLabel>
                <Input
                  id="sshConcurrency"
                  type="number"
                  min={1}
                  max={SSH_INSTALL_LIMITS.maxConcurrency}
                  value={concurrency}
                  onChange={(event) => setConcurrency(event.target.value)}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="sshTimeout">{m.ssh_timeout()}</FieldLabel>
              <Input
                id="sshTimeout"
                type="number"
                min={1}
                max={SSH_INSTALL_LIMITS.maxTimeoutMinutes}
                value={timeout}
                onChange={(event) => setTimeoutMinutes(event.target.value)}
              />
            </Field>
            <Field orientation="horizontal" className="w-auto">
              <Switch id="sshMirrorOnly" checked={mirrorOnly} onCheckedChange={setMirrorOnly} />
              <FieldLabel htmlFor="sshMirrorOnly">{m.ssh_mirror_only()}</FieldLabel>
            </Field>
            <Field orientation="horizontal" className="w-auto">
              <Switch id="sshModsecurity" checked={modsecurity} onCheckedChange={setModsecurity} />
              <FieldLabel htmlFor="sshModsecurity">{m.ssh_modsecurity()}</FieldLabel>
            </Field>
          </div>
        ) : null}
        {formError.length > 0 ? (
          <div className="flex flex-col gap-1" data-testid="ssh-form-error">
            {formError.map((error) => (
              <FieldError key={error}>{error}</FieldError>
            ))}
          </div>
        ) : null}
        {scan.isError ? <FieldError>{errorMessage(scan.error)}</FieldError> : null}
      </FieldGroup>
      <DialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen((value) => !value)}
          data-testid="ssh-options"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className={cn("transition-transform", optionsOpen && "rotate-180")}
          />
          {m.enroll_options()}
        </Button>
        <Button type="submit" disabled={scan.isPending} data-testid="ssh-scan">
          {scan.isPending ? <Spinner /> : null}
          {m.ssh_scan()}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A run's hosts as they go, with retry, stop and the results to copy. */
function RunView({
  runId,
  cluster,
  credential,
  onClose,
}: {
  runId: string;
  cluster: Cluster;
  credential: () => SshCredential;
  onClose: () => void;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const run = useQuery({
    ...orpc.sshInstalls.get.queryOptions({ input: { id: runId } }),
    refetchInterval: (query) =>
      query.state.data?.state === "running" &&
      errorCode(query.state.error) !== "SSH_INSTALL_NOT_FOUND"
        ? 1500
        : false,
    retry: (count, error) => errorCode(error) !== "SSH_INSTALL_NOT_FOUND" && count < 3,
    meta: { background: true },
  });
  const data = run.data;
  const anySucceeded = !!data && data.counts.succeeded > 0;
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: { clusterId: cluster.id } }),
    enabled: anySucceeded,
    refetchInterval: 3000,
    meta: { background: true },
  });
  const cancel = useMutation(orpc.sshInstalls.cancel.mutationOptions());
  const retry = useMutation(orpc.sshInstalls.retry.mutationOptions());
  const lost = errorCode(run.error) === "SSH_INSTALL_NOT_FOUND";
  const nodeById = new Map((nodes.data ?? []).map((n) => [n.id, n]));
  const retryable = data ? data.counts.failed + data.counts.canceled : 0;
  const single = data?.hosts.length === 1 ? data.hosts[0] : undefined;

  const copyResults = async () => {
    if (!data) return;
    const lines = [
      ["host", "port", "user", "state", "error", "node"].join("\t"),
      ...data.hosts.map((h) =>
        [h.host, h.port, h.username, h.state, h.error ?? "", h.nodeId ?? ""].join("\t"),
      ),
    ];
    if (await copyText(`${lines.join("\n")}\n`)) toast.success(m.common_copied());
    else toast.error(m.common_copy_failed());
  };

  return (
    <>
      <div className="flex flex-col gap-3">
        {lost ? (
          <FieldError data-testid="ssh-run-lost">{m.ssh_run_lost()}</FieldError>
        ) : run.isLoadingError ? (
          <FieldError>{errorMessage(run.error)}</FieldError>
        ) : !data ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <>
            <p
              className="text-sm text-muted-foreground"
              data-testid="ssh-run-summary"
              data-state={data.state}
            >
              {m.ssh_run_summary({
                succeeded: data.counts.succeeded,
                failed: data.counts.failed,
                running: data.counts.running + data.counts.queued,
              })}
            </p>
            <div className="overflow-hidden rounded-lg border animate-enter">
              <Table data-testid="ssh-run-hosts">
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.ssh_host()}</TableHead>
                    <TableHead>{m.nodes_col_status()}</TableHead>
                    <TableHead>{m.nodes_col_name()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.hosts.map((h) => {
                    const node = h.nodeId ? nodeById.get(h.nodeId) : undefined;
                    const ready = !!node && node.online && node.applyState === "applied";
                    return (
                      <React.Fragment key={h.id}>
                        <TableRow
                          data-testid="ssh-run-host"
                          data-state={h.state}
                          data-error={h.error ?? undefined}
                          className={cn(h.output && "cursor-pointer")}
                          onClick={() => h.output && setOpen(open === h.id ? null : h.id)}
                        >
                          <TableCell className="font-mono">
                            {h.output ? (
                              <button
                                type="button"
                                aria-expanded={open === h.id}
                                className="flex items-center gap-1 underline-offset-4 hover:underline"
                                data-testid="ssh-host-output-toggle"
                              >
                                <HugeiconsIcon
                                  icon={ArrowDown01Icon}
                                  strokeWidth={2}
                                  className={cn(
                                    "size-3.5 text-muted-foreground transition-transform",
                                    open !== h.id && "-rotate-90",
                                  )}
                                />
                                {hostLabel(h)}
                              </button>
                            ) : (
                              hostLabel(h)
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="flex items-center gap-1.5">
                              <Dot {...HOST_STATE[h.state]} small />
                              {h.error ? sshErrorText(h.error) : stateText(h.state)}
                              {h.state === "installing" && h.step ? (
                                <span className="text-muted-foreground" data-testid="ssh-run-step">
                                  · {stepText(h.step)}
                                </span>
                              ) : null}
                            </span>
                          </TableCell>
                          <TableCell>
                            {node ? (
                              <span className="flex items-center gap-1.5">
                                <Dot tone={ready ? "good" : "idle"} pulse={!ready} small />
                                {node.name}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                        {open === h.id && h.output ? (
                          <TableRow className="hover:bg-transparent">
                            <TableCell colSpan={3} className="p-2">
                              <CodeBlock value={h.output} wrap testId="ssh-host-output" />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {single?.tokenId && single.state === "succeeded" ? (
              <EnrollProgress result={{ tokenId: single.tokenId }} />
            ) : null}
          </>
        )}
        {cancel.isError ? <FieldError>{errorMessage(cancel.error)}</FieldError> : null}
        {retry.isError ? <FieldError>{errorMessage(retry.error)}</FieldError> : null}
      </div>
      <DialogFooter className="sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {data?.state === "running" ? (
            <Button
              variant="secondary"
              disabled={cancel.isPending || lost}
              onClick={() => cancel.mutate({ id: runId }, { onSuccess: () => void run.refetch() })}
              data-testid="ssh-run-cancel"
            >
              {cancel.isPending ? <Spinner /> : null}
              {m.ssh_cancel_run()}
            </Button>
          ) : null}
          {data && data.state !== "running" && retryable > 0 && !lost ? (
            <Button
              variant="secondary"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(
                  { id: runId, credential: credential() },
                  { onSuccess: () => void run.refetch() },
                )
              }
              data-testid="ssh-run-retry"
            >
              {retry.isPending ? <Spinner /> : null}
              {m.ssh_retry_failed({ count: retryable })}
            </Button>
          ) : null}
          {data && data.hosts.length > 1 ? (
            <Button variant="ghost" onClick={copyResults} data-testid="ssh-run-copy">
              {m.ssh_copy_results()}
            </Button>
          ) : null}
        </div>
        <Button onClick={onClose} data-testid="enroll-close">
          {m.common_close()}
        </Button>
      </DialogFooter>
    </>
  );
}
