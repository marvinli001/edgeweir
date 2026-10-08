import type { AcmeCa, AcmeKeyType, CertificateSettings } from "@edgeweir/contract";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { AcmeAccountsCard } from "@/components/acme-accounts";
import { AcmeCaFields, type Eab, eabMissing, eabParams } from "@/components/acme-ca";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DnsCredentialDialog, type EditableCredential } from "@/components/dns/credential-dialog";
import { providerLabel } from "@/components/dns/labels";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { enterDelay, Page } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { Dot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { certificateErrorText } from "@/lib/certificate-errors";
import {
  type CertificateState,
  certificateDaysLeft,
  certificateExpired,
  certificateState,
} from "@/lib/certificate-status";
import { formatDateTime, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/certificates")({ component: CertificatesPage });

function CertificatesPage() {
  const client = useQueryClient();
  const certificates = useQuery({
    ...orpc.certificates.list.queryOptions(),
    refetchInterval: 5000,
    meta: { background: true },
  });
  const credentials = useQuery(orpc.dnsCredentials.list.queryOptions());
  const settings = useQuery(orpc.certificates.settings.queryOptions());
  const remove = useMutation(orpc.certificates.delete.mutationOptions());
  const renew = useMutation(orpc.certificates.renew.mutationOptions());
  const removeDns = useMutation(orpc.dnsCredentials.delete.mutationOptions());
  // A DNS credential is edited in the dialog that adds one ("dns").
  const dialog = useDialogState<"upload" | "request" | "dns" | EditableCredential>();
  const refresh = () => client.invalidateQueries();
  return (
    <Page
      title={m.cert_title()}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => dialog.show("dns")}>
            {m.cert_dns_add()}
          </Button>
          <Button variant="outline" onClick={() => dialog.show("upload")} data-testid="cert-upload">
            {m.cert_upload()}
          </Button>
          <Button onClick={() => dialog.show("request")} data-testid="cert-request">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.cert_request()}
          </Button>
        </div>
      }
    >
      <QueryView
        query={certificates}
        empty={
          <EmptyState title={m.cert_empty()}>
            <Button onClick={() => dialog.show("request")}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.cert_request()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          // One card, a flat row per certificate: name and state, the names it covers, expiry and
          // renewal, then its actions.
          <ul
            className="flex flex-col divide-y rounded-2xl bg-card shadow-elev-1 edge-lit"
            data-testid="certificate-list"
          >
            {list.map((cert, index) => {
              return (
                <li
                  key={cert.id}
                  className="grid gap-x-6 gap-y-3 px-5 py-4 animate-enter @3xl/main:grid-cols-[minmax(0,1fr)_minmax(0,24rem)_9.5rem]"
                  style={enterDelay(index)}
                  data-testid="certificate-card"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{cert.name}</span>
                      <CertificateStatus state={certificateState(cert)} />
                    </div>
                    <p className="font-mono text-xs leading-5 break-all text-muted-foreground">
                      {cert.names.join(", ")}
                    </p>
                    {cert.lastError ? (
                      <SafetyNote className="text-destructive" data-testid="certificate-error">
                        {certificateErrorText(cert.lastError)}
                      </SafetyNote>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 text-sm">
                    {cert.notAfter ? (
                      <span className="text-muted-foreground">
                        {certificateExpired(cert.notAfter)
                          ? m.cert_expired_at({ date: formatDateTime(cert.notAfter) })
                          : m.cert_expires({
                              date: formatDateTime(cert.notAfter),
                              days: certificateDaysLeft(cert.notAfter),
                            })}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">
                      {cert.autoRenew ? m.cert_auto_on() : m.cert_auto_off()}
                    </span>
                    {cert.renewAt && cert.autoRenew ? (
                      <span className="text-xs text-muted-foreground">
                        {m.cert_renew_at({ date: formatDateTime(cert.renewAt) })}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2 @3xl/main:justify-end">
                    {cert.source === "acme" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={renew.isPending || ["pending", "issuing"].includes(cert.status)}
                        onClick={async () => {
                          try {
                            await renew.mutateAsync({ id: cert.id });
                            await refresh();
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        {m.cert_renew()}
                      </Button>
                    ) : null}
                    <ConfirmDialog
                      title={m.cert_delete_confirm({ name: cert.name })}
                      destructive
                      trigger={
                        <Button size="sm" variant="destructive">
                          {m.common_delete()}
                        </Button>
                      }
                      onConfirm={async () => {
                        await remove.mutateAsync({ id: cert.id });
                        await refresh();
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </QueryView>
      <Card>
        <CardHeader>
          <CardTitle>{m.cert_dns_title()}</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryView query={credentials} empty={<EmptyState title={m.cert_dns_empty()} />}>
            {(list) =>
              list.map((credential) => (
                <div
                  key={credential.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b py-3 first:pt-0 last:border-0 last:pb-0"
                >
                  <div className="min-w-48 flex-1">
                    <p className="font-medium break-words">{credential.name}</p>
                    <p className="text-sm break-words text-muted-foreground">{credential.zone}</p>
                  </div>
                  <Badge variant="secondary">{providerLabel(credential.provider)}</Badge>
                  <Button variant="outline" size="sm" onClick={() => dialog.show(credential)}>
                    {m.common_edit()}
                  </Button>
                  <ConfirmDialog
                    title={m.cert_delete_confirm({ name: credential.name })}
                    destructive
                    trigger={
                      <Button variant="destructive" size="sm">
                        {m.common_delete()}
                      </Button>
                    }
                    onConfirm={async () => {
                      await removeDns.mutateAsync({ id: credential.id });
                      await refresh();
                    }}
                  />
                </div>
              ))
            }
          </QueryView>
        </CardContent>
      </Card>
      <AcmeAccountsCard />
      {dialog.value === "upload" ? (
        <UploadDialog key={dialog.key} open={dialog.open} onOpenChange={dialog.onOpenChange} />
      ) : dialog.value === "request" ? (
        <RequestDialog
          key={dialog.key}
          credentials={credentials.data ?? []}
          settings={settings.data}
          open={dialog.open}
          onOpenChange={dialog.onOpenChange}
        />
      ) : dialog.value ? (
        <DnsCredentialDialog
          key={dialog.key}
          scope="credential"
          initial={dialog.value === "dns" ? undefined : dialog.value}
          open={dialog.open}
          onOpenChange={dialog.onOpenChange}
          onSaved={async () => {
            await refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

/**
 * A certificate's state as a tinted chip with its light: ready (good), waiting (idle), issuing
 * (the signal, live), failed, expired or unloadable by nodes (the destructive tint).
 */
function CertificateStatus({ state }: { state: CertificateState }) {
  if (state === "error" || state === "expired" || state === "unloadable") {
    return (
      <Badge variant="destructive" data-testid="certificate-status">
        <Dot tone="bad" small />
        {state === "expired"
          ? m.cert_status_expired()
          : state === "unloadable"
            ? m.cert_status_unloadable()
            : m.cert_status_error()}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" data-testid="certificate-status">
      {state === "issuing" ? (
        <span className="lit-glow dot-pulse relative inline-flex size-1.5 shrink-0 rounded-full border border-transparent bg-signal" />
      ) : (
        <Dot tone={state === "ready" ? "good" : "idle"} small />
      )}
      {state === "ready"
        ? m.cert_status_ready()
        : state === "issuing"
          ? m.cert_status_issuing()
          : m.cert_status_pending()}
    </Badge>
  );
}

function TextField({ id, label, type = "text" }: { id: string; label: string; type?: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={id} type={type} required autoComplete="off" />
    </Field>
  );
}
function UploadDialog({ open, onOpenChange }: DialogProps) {
  const client = useQueryClient();
  const upload = useMutation(orpc.certificates.upload.mutationOptions());
  const [chain, setChain] = React.useState("");
  const [key, setKey] = React.useState("");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.cert_upload()}
      submitLabel={m.cert_upload()}
      submitTestId="cert-upload-submit"
      onSubmit={async (data) => {
        await upload.mutateAsync({
          name: String(data.get("certName")),
          chainPem: chain,
          privateKeyPem: key,
        });
        setKey("");
        await client.invalidateQueries();
        onOpenChange(false);
      }}
    >
      <TextField id="certName" label={m.cert_name()} />
      <Field>
        <FieldLabel htmlFor="chainPem">{m.cert_chain()}</FieldLabel>
        <Input
          type="file"
          accept=".pem,.crt,.cer"
          aria-label={m.cert_chain()}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setChain(await file.text());
          }}
        />
        <Textarea
          id="chainPem"
          value={chain}
          onChange={(e) => setChain(e.target.value)}
          required
          rows={5}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="keyPem">{m.cert_key()}</FieldLabel>
        <Input
          type="file"
          accept=".pem,.key"
          aria-label={m.cert_key()}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setKey(await file.text());
          }}
        />
        <Textarea
          id="keyPem"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
          rows={4}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    </FormDialog>
  );
}
function RequestDialog({
  credentials,
  settings,
  open,
  onOpenChange,
}: {
  credentials: { id: string; name: string }[];
  /** The custom ACME directory, and the CA a request without one uses. */
  settings: CertificateSettings | undefined;
} & DialogProps) {
  const client = useQueryClient();
  const request = useMutation(orpc.certificates.request.mutationOptions());
  const [ca, setCa] = React.useState<AcmeCa>(settings?.defaultCa ?? "letsencrypt");
  const [eab, setEab] = React.useState<Eab>({ kid: "", key: "" });
  const [keyType, setKeyType] = React.useState<AcmeKeyType>("ec256");
  const [challenge, setChallenge] = React.useState("http01");
  const [credential, setCredential] = React.useState(credentials[0]?.id ?? "");
  const [skipDnsCheck, setSkipDnsCheck] = React.useState(false);
  const [names, setNames] = React.useState("");
  const parsedNames = names.split(/[\s,]+/).filter(Boolean);
  // HTTP-01 cannot validate wildcards (the API refuses them too).
  const wildcard = challenge === "http01" && parsedNames.some((n) => n.startsWith("*."));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.cert_request()}
      submitLabel={m.cert_request()}
      submitTestId="cert-request-submit"
      onSubmit={async (data) => {
        if (wildcard || eabMissing(ca, eab)) return;
        await request.mutateAsync({
          name: String(data.get("certName")),
          names: parsedNames,
          email: String(data.get("email")),
          ca,
          keyType,
          challenge: challenge as "http01" | "dns01",
          ...(challenge === "dns01" ? { dnsCredentialId: credential } : { skipDnsCheck }),
          ...eabParams(ca, eab),
        });
        await client.invalidateQueries();
        onOpenChange(false);
      }}
    >
      <TextField id="certName" label={m.cert_name()} />
      <Field data-invalid={wildcard || undefined}>
        <FieldLabel htmlFor="names">{m.cert_domains()}</FieldLabel>
        <Input
          id="names"
          name="names"
          required
          autoComplete="off"
          value={names}
          onChange={(event) => setNames(event.target.value)}
          aria-invalid={wildcard || undefined}
        />
        {wildcard ? (
          <FieldError className="animate-in fade-in" data-testid="cert-names-error">
            {m.cert_wildcard_needs_dns01()}
          </FieldError>
        ) : null}
      </Field>
      <TextField id="email" label={m.cert_email()} type="email" />
      <AcmeCaFields
        idPrefix="cert"
        ca={ca}
        onCaChange={setCa}
        eab={eab}
        onEabChange={setEab}
        settings={settings}
      />
      <FormSelect
        id="certKeyType"
        label={m.cert_key_type()}
        value={keyType}
        onChange={(value) => setKeyType(value as AcmeKeyType)}
        options={[
          { value: "ec256", label: m.cert_key_ec256() },
          { value: "rsa2048", label: m.cert_key_rsa2048() },
        ]}
      />
      <FormSelect
        id="certChallenge"
        label={m.cert_challenge()}
        value={challenge}
        onChange={setChallenge}
        options={[
          { value: "http01", label: m.cert_http01() },
          { value: "dns01", label: m.cert_dns01() },
        ]}
      />
      {challenge === "dns01" ? (
        <FormSelect
          id="certCredential"
          label={m.cert_dns_title()}
          value={credential}
          onChange={setCredential}
          options={credentials.map((c) => ({ value: c.id, label: c.name }))}
        />
      ) : (
        <SwitchField
          id="certSkipDnsCheck"
          label={m.cert_skip_dns_check()}
          checked={skipDnsCheck}
          onCheckedChange={setSkipDnsCheck}
          className="self-start"
        />
      )}
    </FormDialog>
  );
}
