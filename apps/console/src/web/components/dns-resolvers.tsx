import { type DnsResolvers, MAX_DNS_RESOLVERS, parseDnsResolver } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SafetyNote } from "@/components/safety-note";
import { SaveBar, splitList } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const sourceLabel: Record<DnsResolvers["source"], () => string> = {
  setting: m.system_dns_source_setting,
  environment: m.system_dns_source_environment,
  default: m.system_dns_source_default,
};

/** Admin card: recursive DNS servers that domain ownership TXT checks query. */
export function DnsResolversCard() {
  const query = useQuery(orpc.settings.dnsResolvers.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "80ms" }}>
      <CardHeader>
        <CardTitle>{m.system_dns_resolvers_title()}</CardTitle>
      </CardHeader>
      {query.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : query.isError ? (
        <CardContent>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </CardContent>
      ) : (
        <DnsResolversForm key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
  );
}

function DnsResolversForm({ initial }: { initial: DnsResolvers }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setDnsResolvers.mutationOptions());
  const [text, setText] = React.useState(initial.servers.join("\n"));
  const [error, setError] = React.useState<string | null>(null);
  const entries = splitList(text);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const invalid = entries.find((entry) => parseDnsResolver(entry) === null);
    if (invalid !== undefined) {
      setError(m.system_dns_resolvers_invalid({ value: invalid }));
      return;
    }
    if (entries.length > MAX_DNS_RESOLVERS) {
      setError(m.system_dns_resolvers_too_many({ max: MAX_DNS_RESOLVERS }));
      return;
    }
    setError(null);
    try {
      await save.mutateAsync({ servers: entries });
      await queryClient.invalidateQueries({ queryKey: orpc.settings.dnsResolvers.key() });
      toast.success(m.common_saved());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <CardContent className="flex flex-col gap-3">
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="dns-resolvers" className="flex items-center gap-2">
            {m.system_dns_resolvers_label()}
            <Badge variant="secondary" data-testid="dns-resolvers-origin">
              {sourceLabel[initial.source]()}
            </Badge>
          </FieldLabel>
          <Textarea
            id="dns-resolvers"
            rows={3}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            placeholder={
              initial.effectiveServers.length
                ? initial.effectiveServers.join("\n")
                : m.system_dns_resolvers_system()
            }
            aria-invalid={error ? true : undefined}
            className="min-h-20 font-mono text-sm"
            data-testid="dns-resolvers"
          />
        </Field>
        <SafetyNote>{m.system_dns_resolvers_note()}</SafetyNote>
      </CardContent>
      <SaveBar
        dirty={entries.join("\n") !== initial.servers.join("\n")}
        pending={save.isPending}
        error={error}
        testId="dns-resolvers-save"
      />
    </form>
  );
}
