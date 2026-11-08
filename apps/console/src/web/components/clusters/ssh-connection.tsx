import { sshJumpHost } from "@edgeweir/contract";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Switch } from "@/components/arc/switch/switch";
import { Textarea } from "@/components/arc/textarea/textarea";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldLabel } from "@/components/layout/form";
import { Spinner } from "@/components/layout/spinner";
import { SafetyNote } from "@/components/safety-note";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export interface SshConnectionDraft {
  tty: "auto" | "always" | "never";
  enabled: boolean;
  host: string;
  port: string;
  username: string;
  auth: "password" | "key" | "agent";
  password: string;
  privateKey: string;
  passphrase: string;
  fingerprint: string;
  confirmed: boolean;
}
export const emptySshConnection: SshConnectionDraft = {
  tty: "auto",
  enabled: false,
  host: "",
  port: "22",
  username: "root",
  auth: "password",
  password: "",
  privateKey: "",
  passphrase: "",
  fingerprint: "",
  confirmed: false,
};
export function readSshConnection(draft: SshConnectionDraft) {
  if (!draft.enabled) return { tty: draft.tty };
  const result = sshJumpHost.safeParse({
    host: draft.host,
    port: Number(draft.port),
    hostKeyFingerprint: draft.fingerprint,
    credential: {
      username: draft.username,
      agent: draft.auth === "agent",
      ...(draft.auth === "password"
        ? { password: draft.password }
        : draft.auth === "key"
          ? {
              privateKey: draft.privateKey,
              ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
            }
          : {}),
    },
  });
  return result.success && draft.confirmed ? { tty: draft.tty, jumpHost: result.data } : null;
}

export function SshConnectionFields({
  value,
  onChange,
  agentAvailable,
}: {
  value: SshConnectionDraft;
  onChange: (value: SshConnectionDraft) => void;
  agentAvailable: boolean;
}) {
  const scan = useMutation(orpc.sshInstalls.scanHostKeys.mutationOptions());
  const set = (patch: Partial<SshConnectionDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      <Field>
        <FieldLabel>{m.ssh_tty()}</FieldLabel>
        <OptionSelect
          label={m.ssh_tty()}
          value={value.tty}
          onChange={(tty) => set({ tty: tty as SshConnectionDraft["tty"] })}
          options={[
            { value: "auto", label: m.ssh_tty_auto() },
            { value: "always", label: m.ssh_tty_always() },
            { value: "never", label: m.ssh_tty_never() },
          ]}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="sshJumpEnabled">{m.ssh_jump()}</FieldLabel>
        <Switch
          id="sshJumpEnabled"
          checked={value.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
        />
      </Field>
      {value.enabled ? (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_6rem_8rem]">
            <Field>
              <FieldLabel htmlFor="sshJumpHost">{m.ssh_host()}</FieldLabel>
              <Input
                id="sshJumpHost"
                autoComplete="off"
                value={value.host}
                onChange={(e) => set({ host: e.target.value, confirmed: false, fingerprint: "" })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sshJumpPort">{m.ssh_port()}</FieldLabel>
              <Input
                id="sshJumpPort"
                inputMode="numeric"
                value={value.port}
                onChange={(e) => set({ port: e.target.value, confirmed: false, fingerprint: "" })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sshJumpUser">{m.ssh_user()}</FieldLabel>
              <Input
                id="sshJumpUser"
                autoComplete="off"
                value={value.username}
                onChange={(e) => set({ username: e.target.value })}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel>{m.ssh_jump_auth()}</FieldLabel>
            <OptionSelect
              label={m.ssh_jump_auth()}
              value={value.auth}
              onChange={(auth) => set({ auth: auth as SshConnectionDraft["auth"] })}
              options={[
                { value: "password", label: m.ssh_auth_password() },
                { value: "key", label: m.ssh_auth_key() },
                ...(agentAvailable ? [{ value: "agent", label: m.ssh_auth_agent() }] : []),
              ]}
            />
          </Field>
          {value.auth === "password" ? (
            <Field>
              <FieldLabel htmlFor="sshJumpPassword">{m.ssh_password()}</FieldLabel>
              <Input
                id="sshJumpPassword"
                type="password"
                autoComplete="off"
                value={value.password}
                onChange={(e) => set({ password: e.target.value })}
              />
            </Field>
          ) : value.auth === "key" ? (
            <>
              <Field>
                <FieldLabel htmlFor="sshJumpKey">{m.ssh_private_key()}</FieldLabel>
                <Textarea
                  id="sshJumpKey"
                  rows={4}
                  autoComplete="off"
                  spellCheck={false}
                  value={value.privateKey}
                  onChange={(e) => set({ privateKey: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sshJumpPassphrase">{m.ssh_passphrase()}</FieldLabel>
                <Input
                  id="sshJumpPassphrase"
                  type="password"
                  autoComplete="off"
                  value={value.passphrase}
                  onChange={(e) => set({ passphrase: e.target.value })}
                />
              </Field>
            </>
          ) : null}
          <Field>
            <FieldLabel htmlFor="sshJumpFingerprint">{m.ssh_jump_fingerprint()}</FieldLabel>
            <Input
              id="sshJumpFingerprint"
              className="font-mono"
              value={value.fingerprint}
              onChange={(e) => set({ fingerprint: e.target.value, confirmed: false })}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            disabled={scan.isPending || !value.host}
            onClick={async () => {
              try {
                const result = await scan.mutateAsync({
                  hosts: [{ host: value.host, port: Number(value.port) }],
                });
                set({ fingerprint: result.hosts[0]?.fingerprint ?? "", confirmed: false });
              } catch {
                /* rendered below */
              }
            }}
          >
            {scan.isPending ? <Spinner /> : null}
            {m.ssh_jump_scan()}
          </Button>
          {scan.data?.hosts[0]?.error ? (
            <FieldError>
              {{
                unreachable: m.ssh_scan_error_unreachable,
                timeout: m.ssh_scan_error_timeout,
                not_ssh: m.ssh_scan_error_not_ssh,
                outbound_refused: m.ssh_scan_error_outbound_refused,
                host_key_mismatch: m.ssh_install_error_host_key_mismatch,
                auth_failed: m.ssh_install_error_auth_failed,
                agent_unavailable: m.ssh_install_error_agent_unavailable,
                connection_lost: m.ssh_install_error_connection_lost,
              }[scan.data.hosts[0].error]()}
            </FieldError>
          ) : null}
          {scan.isError ? <FieldError>{errorMessage(scan.error)}</FieldError> : null}
          <Field orientation="horizontal">
            <FieldLabel htmlFor="sshJumpConfirmed">{m.ssh_jump_confirm()}</FieldLabel>
            <Switch
              id="sshJumpConfirmed"
              checked={value.confirmed}
              disabled={!value.fingerprint}
              onCheckedChange={(confirmed) => set({ confirmed })}
            />
          </Field>
          <SafetyNote>{m.ssh_fingerprint_note()}</SafetyNote>
        </>
      ) : null}
    </div>
  );
}
