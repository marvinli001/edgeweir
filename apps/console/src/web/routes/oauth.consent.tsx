import { type ConsentRequest, MCP_SCOPE_WRITE } from "@edgeweir/contract";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { AuthFrame, AuthShell } from "@/components/auth-shell";
import { FieldError } from "@/components/layout/form";
import {
  Panel,
  PanelContent,
  PanelFooter,
  PanelHeader,
  PanelTitle,
} from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import { SafetyNote } from "@/components/safety-note";
import { QueryView } from "@/components/states";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * Where the console's authorization server sends a signed-in browser to approve an MCP client
 * (ADR-0076). The page's query is the signed authorization request, passed through as is.
 */
export const Route = createFileRoute("/oauth/consent")({
  component: ConsentPage,
});

function ConsentPage() {
  const [oauthQuery] = React.useState(() => window.location.search.replace(/^\?/, ""));
  const request = useQuery({
    ...orpc.mcp.consentRequest.queryOptions({ input: { oauthQuery } }),
    enabled: oauthQuery.length > 0,
    retry: false,
  });
  return (
    <AuthShell className="max-w-md">
      <AuthFrame>
        <Panel>
          <QueryView query={request} frame={PanelContent}>
            {(data) => <ConsentForm request={data} oauthQuery={oauthQuery} />}
          </QueryView>
        </Panel>
      </AuthFrame>
    </AuthShell>
  );
}

function ConsentForm({ request, oauthQuery }: { request: ConsentRequest; oauthQuery: string }) {
  const wantsWrite = request.scopes.includes(MCP_SCOPE_WRITE) && !request.readOnly;
  // Reads unless the operator picks more: least privilege by default.
  const [access, setAccess] = React.useState<"read" | "write">("read");
  const [leaving, setLeaving] = React.useState(false);
  const consent = useMutation({
    ...orpc.mcp.consent.mutationOptions(),
    onSuccess: ({ url }) => {
      setLeaving(true);
      window.location.assign(url);
    },
  });
  const answer = (accept: boolean) => consent.mutate({ oauthQuery, accept, access });
  const busy = consent.isPending || leaving;
  return (
    <>
      <PanelHeader>
        <PanelTitle className="text-title" data-testid="consent-title">
          {m.oauth_consent_title({ name: request.clientName })}
        </PanelTitle>
      </PanelHeader>
      <PanelContent className="flex flex-col gap-4">
        <dl className="divide-y rounded-lg text-sm faint-well">
          <ConsentRow label={m.oauth_consent_client()}>
            {request.clientIdHost ?? m.oauth_consent_registered()}
          </ConsentRow>
          <ConsentRow label={m.oauth_consent_redirect()}>{request.redirectHost}</ConsentRow>
        </dl>
        {request.localhost ? (
          <SafetyNote className="text-warning-ink" data-testid="consent-localhost">
            {m.oauth_consent_localhost()}
          </SafetyNote>
        ) : null}
        {wantsWrite ? (
          <Tabs value={access} onValueChange={(value) => setAccess(value as "read" | "write")}>
            <TabsList className="w-full" aria-label={m.oauth_consent_access()}>
              <TabsTrigger value="read" className="flex-1" data-testid="consent-read">
                {m.oauth_access_read()}
              </TabsTrigger>
              <TabsTrigger value="write" className="flex-1" data-testid="consent-write">
                {m.oauth_access_write()}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          <p className="text-sm font-medium" data-testid="consent-read-only">
            {m.oauth_access_read()}
          </p>
        )}
        {request.readOnly ? <SafetyNote>{m.oauth_consent_demo()}</SafetyNote> : null}
        {access === "write" && wantsWrite ? (
          <SafetyNote className="animate-enter">{m.oauth_consent_write_note()}</SafetyNote>
        ) : null}
      </PanelContent>
      <PanelFooter className="flex-wrap justify-end gap-3 border-t">
        {consent.isError ? (
          <FieldError className="mr-auto animate-in fade-in">
            {localizeError(consent.error)}
          </FieldError>
        ) : null}
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => answer(false)}
          data-testid="consent-deny"
        >
          {m.oauth_consent_deny()}
        </Button>
        <Button disabled={busy} onClick={() => answer(true)} data-testid="consent-allow">
          {busy ? <Spinner /> : null}
          {m.oauth_consent_allow()}
        </Button>
      </PanelFooter>
    </>
  );
}

function ConsentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[13px]">{children}</dd>
    </div>
  );
}
