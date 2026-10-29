import type { AcmeCa, AcmeKeyType, CertificateDto, CertificateSettings } from "@edgeweir/contract";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { AcmeAccountsCard } from "@/components/acme-accounts";
import { AcmeCaFields, type Eab, eabMissing, eabParams } from "@/components/acme-ca";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { DropdownMenuItem } from "@/components/arc/dropdown-menu/dropdown-menu";
import { Input } from "@/components/arc/input/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { Textarea } from "@/components/arc/textarea/textarea";
import { DnsCredentialDialog, type EditableCredential } from "@/components/dns/credential-dialog";
import { providerLabel } from "@/components/dns/labels";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Field, FieldError, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { OriginCaPanel, OriginClientPanel } from "@/components/origin-pki";
import { enterDelay, Page, PageTabs } from "@/components/page";
import { ItemMenu } from "@/components/row-menu";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { Dot } from "@/components/status-dot";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { certificateErrorText } from "@/lib/certificate-errors";
import {
  type CertificateState,
  certificateDaysLeft,
  certificateExpired,
  certificateState,
} from "@/lib/certificate-status";
import { formatDateTime, formatList, formatNumber, m } from "@/lib/i18n";
import { splitList } from "@/lib/lists";
import { orpc } from "@/lib/orpc";
import { rowActivationHandlers, rowClickable, rowLink, rowLinkButton } from "@/lib/row-link";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/certificates")({
  validateSearch: z.object({
    tab: z.enum(["origin-ca", "origin-client"]).optional(),
    /** Opens the certificate request (the command menu's action). */
    request: z.boolean().optional(),
  }),
  component: CertificatesPage,
});

type Tab = "certificates" | "origin-ca" | "origin-client";

/** Certificates for visitors, the Origin CA for origins, and the origin client CA. */
function CertificatesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: Tab = search.tab ?? "certificates";
  // A DNS credential is edited in the dialog that adds one ("dns").
  const dialog = useDialogState<CertificateDialog>();
  const issue = useDialogState();
  // A link with `request` opens the request dialog once and leaves the address clean.
  const { show } = dialog;
  React.useEffect(() => {
    if (!search.request) return;
    show("request");
    void navigate({ search: (prev) => ({ ...prev, request: undefined }), replace: true });
  }, [search.request, show, navigate]);
  return (
    <Page
      title={m.cert_title()}
      actions={
        tab === "certificates" ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => dialog.show("dns")}>
              {m.cert_dns_add()}
            </Button>
            <Button
              variant="secondary"
              onClick={() => dialog.show("upload")}
              data-testid="cert-upload"
            >
              {m.cert_upload()}
            </Button>
            <Button onClick={() => dialog.show("request")} data-testid="cert-request">
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.cert_request()}
            </Button>
          </div>
        ) : tab === "origin-ca" ? (
          <Button onClick={() => issue.show()} data-testid="origin-cert-issue">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.origin_cert_issue()}
          </Button>
        ) : null
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) =>
          navigate({
            search: { tab: value === "origin-ca" || value === "origin-client" ? value : undefined },
            replace: true,
          })
        }
      >
        {/* The page's tab bar, in the header band. */}
        <PageTabs>
          <TabsList
            variant="line"
            className="w-full max-w-full justify-start overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
          >
            <TabsTrigger
              value="certificates"
              className="flex-none"
              data-testid="cert-tab-certificates"
            >
              {m.cert_tab_certificates()}
            </TabsTrigger>
            <TabsTrigger value="origin-ca" className="flex-none" data-testid="cert-tab-origin-ca">
              {m.cert_tab_origin_ca()}
            </TabsTrigger>
            <TabsTrigger
              value="origin-client"
              className="flex-none"
              data-testid="cert-tab-origin-client"
            >
              {m.cert_tab_origin_client()}
            </TabsTrigger>
          </TabsList>
        </PageTabs>
        <TabsContent value="certificates" className="flex flex-col gap-6 animate-enter">
          <CertificatesPanel dialog={dialog} />
        </TabsContent>
        <TabsContent value="origin-ca" className=" animate-enter">
          <OriginCaPanel issue={issue} />
        </TabsContent>
        <TabsContent value="origin-client" className=" animate-enter">
          <OriginClientPanel />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

type CertificateDialog = "upload" | "request" | "dns" | EditableCredential;

/** Certificates visitors are served, the DNS credentials of DNS-01 and the ACME accounts. */
function CertificatesPanel({
  dialog,
}: {
  dialog: ReturnType<typeof useDialogState<CertificateDialog>>;
}) {
  const client = useQueryClient();
  const certificates = useQuery({
    ...orpc.certificates.list.queryOptions(),
    refetchInterval: 5000,
    meta: { background: true },
  });
  const credentials = useQuery(orpc.dnsCredentials.list.queryOptions());
  const settings = useQuery(orpc.certificates.settings.queryOptions());
  // Certificates show on sites and in revisions: every change refreshes everything.
  const remove = useMutation({
    ...orpc.certificates.delete.mutationOptions(),
    meta: { invalidates: "all" },
  });
  const renew = useMutation({
    ...orpc.certificates.renew.mutationOptions(),
    meta: { invalidates: "all", toastError: true },
  });
  const removeDns = useMutation({
    ...orpc.dnsCredentials.delete.mutationOptions(),
    meta: { invalidates: "all" },
  });
  const refresh = () => client.invalidateQueries();
  return (
    <>
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
          <div className="overflow-clip rounded-lg border bg-card">
            <ul className="flex flex-col divide-y" data-testid="certificate-list">
              {list.map((cert, index) => {
                return (
                  <li
                    key={cert.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-3 px-5 py-4 animate-enter @3xl/main:grid-cols-[minmax(0,1fr)_22rem_auto]"
                    style={enterDelay(index)}
                    data-testid="certificate-card"
                  >
                    <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-1.5">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate font-medium" title={cert.name}>
                          {cert.name}
                        </span>
                        <CertificateStatus state={certificateState(cert)} />
                      </div>
                      <p className="font-mono text-xs leading-5 [overflow-wrap:anywhere] text-muted-foreground">
                        {cert.names.join(", ")}
                      </p>
                      {cert.lastError ? (
                        <SafetyNote className="text-destructive" data-testid="certificate-error">
                          {certificateErrorText(cert.lastError)}
                        </SafetyNote>
                      ) : null}
                      <NodeFailures failures={cert.nodeFailures} />
                    </div>
                    <div className="col-span-2 row-start-2 flex min-w-0 flex-col gap-1 text-sm @3xl/main:col-span-1 @3xl/main:col-start-2 @3xl/main:row-start-1">
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
                    <div className="col-start-2 row-start-1 flex justify-end @3xl/main:col-start-3">
                      <ItemMenu
                        testId="certificate-actions"
                        remove={{
                          title: m.cert_delete_confirm({ name: cert.name }),
                          onConfirm: () => remove.mutateAsync({ id: cert.id }),
                        }}
                      >
                        {cert.source === "acme" ? (
                          <DropdownMenuItem
                            disabled={
                              renew.isPending || ["pending", "issuing"].includes(cert.status)
                            }
                            onClick={() => renew.mutate({ id: cert.id })}
                            data-testid="certificate-renew"
                          >
                            {m.cert_renew()}
                          </DropdownMenuItem>
                        ) : null}
                      </ItemMenu>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div
              className="border-t px-4 py-2.5 text-dense text-muted-foreground"
              data-slot="table-footer"
            >
              <span className="readout" data-testid="table-total">
                {m.table_total({ count: formatNumber(list.length) })}
              </span>
            </div>
          </div>
        )}
      </QueryView>
      <Panel>
        <PanelHeader>
          <PanelTitle>{m.cert_dns_title()}</PanelTitle>
        </PanelHeader>
        <PanelContent>
          <QueryView query={credentials} empty={<EmptyState compact title={m.cert_dns_empty()} />}>
            {(list) =>
              list.map((credential) => (
                <div
                  key={credential.id}
                  className={cn("-mx-3 flex items-center gap-2 rounded-md px-3 py-3", rowClickable)}
                  {...rowActivationHandlers}
                >
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className={cn(rowLinkButton, "font-medium break-words")}
                      onClick={() => dialog.show(credential)}
                      {...rowLink}
                    >
                      {credential.name}
                    </button>
                    <p className="text-sm break-words text-muted-foreground">{credential.zone}</p>
                  </div>
                  <Badge size="sm" tone="neutral">
                    {providerLabel(credential.provider)}
                  </Badge>
                  <ItemMenu
                    testId="dns-credential-actions"
                    remove={{
                      title: m.cert_delete_confirm({ name: credential.name }),
                      onConfirm: () => removeDns.mutateAsync({ id: credential.id }),
                    }}
                  />
                </div>
              ))
            }
          </QueryView>
        </PanelContent>
      </Panel>
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
          onSaved={refresh}
        />
      ) : null}
    </>
  );
}

/**
 * The nodes that report they cannot load the certificate: those that refuse
 * its TLS handshakes, then those still serving its earlier version.
 */
function NodeFailures({ failures }: { failures: CertificateDto["nodeFailures"] }) {
  const refused = failures.filter((f) => !f.servingEarlier).map((f) => f.nodeName);
  const earlier = failures.filter((f) => f.servingEarlier).map((f) => f.nodeName);
  return (
    <>
      {refused.length ? (
        <SafetyNote className="text-destructive" data-testid="certificate-node-failures">
          {m.cert_node_failures_refused({ nodes: formatList(refused) })}
        </SafetyNote>
      ) : null}
      {earlier.length ? (
        <SafetyNote data-testid="certificate-node-failures-earlier">
          {m.cert_node_failures_earlier({ nodes: formatList(earlier) })}
        </SafetyNote>
      ) : null}
    </>
  );
}

/**
 * A certificate's state as a tinted chip with its light: ready (good), waiting (idle), issuing
 * (the signal, live), failed, expired or unloadable by nodes (the destructive tint).
 */
function CertificateStatus({ state }: { state: CertificateState }) {
  if (state === "error" || state === "expired" || state === "unloadable") {
    return (
      <Badge size="sm" tone="danger" data-testid="certificate-status">
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
    <Badge size="sm" tone="neutral" data-testid="certificate-status">
      {state === "issuing" ? (
        <span className="dot-pulse relative inline-flex size-1.5 shrink-0 rounded-full border border-transparent bg-signal" />
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
  const upload = useMutation({
    ...orpc.certificates.upload.mutationOptions(),
    meta: { invalidates: "all" },
  });
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
  const request = useMutation({
    ...orpc.certificates.request.mutationOptions(),
    meta: { invalidates: "all" },
  });
  const [ca, setCa] = React.useState<AcmeCa>(settings?.defaultCa ?? "letsencrypt");
  const [eab, setEab] = React.useState<Eab>({ kid: "", key: "" });
  const [keyType, setKeyType] = React.useState<AcmeKeyType>("ec256");
  const [challenge, setChallenge] = React.useState("http01");
  const [credential, setCredential] = React.useState(credentials[0]?.id ?? "");
  const [skipDnsCheck, setSkipDnsCheck] = React.useState(false);
  const [names, setNames] = React.useState("");
  const parsedNames = splitList(names);
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
