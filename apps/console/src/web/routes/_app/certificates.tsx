import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DnsCredentialDialog, type EditableCredential } from "@/components/dns/credential-dialog";
import { providerLabel } from "@/components/dns/labels";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { certificateErrorText } from "@/lib/certificate-errors";
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
  const remove = useMutation(orpc.certificates.delete.mutationOptions());
  const renew = useMutation(orpc.certificates.renew.mutationOptions());
  const removeDns = useMutation(orpc.dnsCredentials.delete.mutationOptions());
  const [dialog, setDialog] = React.useState<"upload" | "request" | "dns" | null>(null);
  const [editing, setEditing] = React.useState<EditableCredential | null>(null);
  const refresh = () => client.invalidateQueries();
  const status = {
    pending: m.cert_status_pending,
    issuing: m.cert_status_issuing,
    ready: m.cert_status_ready,
    error: m.cert_status_error,
  };
  return (
    <Page
      title={m.cert_title()}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDialog("dns")}>
            {m.cert_dns_add()}
          </Button>
          <Button variant="outline" onClick={() => setDialog("upload")} data-testid="cert-upload">
            {m.cert_upload()}
          </Button>
          <Button onClick={() => setDialog("request")} data-testid="cert-request">
            {m.cert_request()}
          </Button>
        </div>
      }
    >
      {certificates.isPending ? (
        <LoadingState />
      ) : certificates.isLoadingError ? (
        <ErrorState error={certificates.error} onRetry={() => void certificates.refetch()} />
      ) : !certificates.data.length ? (
        <EmptyState title={m.cert_empty()}>
          <Button onClick={() => setDialog("request")}>{m.cert_request()}</Button>
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {certificates.data.map((cert) => (
            <Card key={cert.id} className="animate-enter" data-testid="certificate-card">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="truncate">{cert.name}</CardTitle>
                <Badge variant={cert.status === "error" ? "destructive" : "secondary"}>
                  {status[cert.status]()}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="break-all text-sm">{cert.names.join(", ")}</p>
                {cert.lastError ? (
                  <SafetyNote className="text-destructive" data-testid="certificate-error">
                    {certificateErrorText(cert.lastError)}
                  </SafetyNote>
                ) : null}
                {cert.notAfter ? (
                  <p className="text-sm text-muted-foreground">
                    {m.cert_expires({
                      date: formatDateTime(cert.notAfter),
                      days: Math.max(
                        0,
                        Math.ceil((Date.parse(cert.notAfter) - Date.now()) / 86_400_000),
                      ),
                    })}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {cert.autoRenew ? m.cert_auto_on() : m.cert_auto_off()}
                </p>
                {cert.renewAt && cert.autoRenew ? (
                  <p className="text-xs text-muted-foreground">
                    {m.cert_renew_at({ date: formatDateTime(cert.renewAt) })}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
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
                      <Button size="sm" variant="ghost">
                        {m.common_delete()}
                      </Button>
                    }
                    onConfirm={async () => {
                      await remove.mutateAsync({ id: cert.id });
                      await refresh();
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{m.cert_dns_title()}</CardTitle>
        </CardHeader>
        <CardContent>
          {credentials.isPending ? (
            <LoadingState />
          ) : credentials.isLoadingError ? (
            <ErrorState error={credentials.error} onRetry={() => void credentials.refetch()} />
          ) : !credentials.data.length ? (
            <EmptyState title={m.cert_dns_empty()} />
          ) : (
            credentials.data.map((credential) => (
              <div
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b py-3 last:border-0"
              >
                <div className="min-w-48 flex-1">
                  <p className="font-medium break-words">{credential.name}</p>
                  <p className="text-sm break-words text-muted-foreground">{credential.zone}</p>
                </div>
                <Badge variant="outline">{providerLabel(credential.provider)}</Badge>
                <Button variant="ghost" size="sm" onClick={() => setEditing(credential)}>
                  {m.common_edit()}
                </Button>
                <ConfirmDialog
                  title={m.cert_delete_confirm({ name: credential.name })}
                  destructive
                  trigger={
                    <Button variant="ghost" size="sm">
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
          )}
        </CardContent>
      </Card>
      {dialog === "upload" ? <UploadDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "request" ? (
        <RequestDialog credentials={credentials.data ?? []} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "dns" || editing ? (
        <DnsCredentialDialog
          scope="credential"
          initial={editing ?? undefined}
          onClose={() => {
            setDialog(null);
            setEditing(null);
          }}
          onSaved={async () => {
            await refresh();
          }}
        />
      ) : null}
    </Page>
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
function UploadDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const upload = useMutation(orpc.certificates.upload.mutationOptions());
  const [chain, setChain] = React.useState("");
  const [key, setKey] = React.useState("");
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
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
        onClose();
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
  onClose,
}: {
  credentials: { id: string; name: string }[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const request = useMutation(orpc.certificates.request.mutationOptions());
  const [ca, setCa] = React.useState("letsencrypt");
  const [challenge, setChallenge] = React.useState("http01");
  const [credential, setCredential] = React.useState(credentials[0]?.id ?? "");
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={m.cert_request()}
      submitLabel={m.cert_request()}
      submitTestId="cert-request-submit"
      onSubmit={async (data) => {
        await request.mutateAsync({
          name: String(data.get("certName")),
          names: String(data.get("names"))
            .split(/[\s,]+/)
            .filter(Boolean),
          email: String(data.get("email")),
          ca: ca as "letsencrypt" | "zerossl",
          challenge: challenge as "http01" | "dns01",
          ...(challenge === "dns01" ? { dnsCredentialId: credential } : {}),
          ...(ca === "zerossl"
            ? { eabKid: String(data.get("eabKid")), eabHmacKey: String(data.get("eabHmacKey")) }
            : {}),
        });
        await client.invalidateQueries();
        onClose();
      }}
    >
      <TextField id="certName" label={m.cert_name()} />
      <TextField id="names" label={m.cert_domains()} />
      <TextField id="email" label={m.cert_email()} type="email" />
      <FormSelect
        id="certCa"
        label={m.cert_ca()}
        value={ca}
        onChange={setCa}
        options={[
          { value: "letsencrypt", label: m.cert_ca_letsencrypt() },
          { value: "zerossl", label: m.cert_ca_zerossl() },
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
      ) : null}
      {ca === "zerossl" ? (
        <>
          <TextField id="eabKid" label={m.cert_eab_kid()} />
          <TextField id="eabHmacKey" label={m.cert_eab_key()} type="password" />
        </>
      ) : null}
    </FormDialog>
  );
}
