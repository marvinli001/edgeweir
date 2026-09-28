import { type ReleaseSource, releaseSourceInput } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const sourceLabel: Record<ReleaseSource["source"], () => string> = {
  setting: m.system_release_source_setting,
  environment: m.system_release_source_environment,
  default: m.system_release_source_default,
};

/** Admin card: the mirror node upgrades read release manifests from. */
export function ReleaseSourceCard() {
  const query = useQuery(orpc.settings.releaseSource.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <CardHeader>
        <CardTitle>{m.system_release_title()}</CardTitle>
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
        <ReleaseSourceForm key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
  );
}

function ReleaseSourceForm({ initial }: { initial: ReleaseSource }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setReleaseSource.mutationOptions());
  const [url, setUrl] = React.useState(initial.url);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = releaseSourceInput.safeParse({ url: url.trim() });
    if (!parsed.success) {
      setError(m.system_release_invalid());
      return;
    }
    setError(null);
    try {
      await save.mutateAsync(parsed.data);
      await queryClient.invalidateQueries({ queryKey: orpc.settings.releaseSource.key() });
      toast.success(m.common_saved());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <CardContent>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="release-source" className="flex items-center gap-2">
            {m.system_release_url()}
            <Badge variant="secondary" data-testid="release-source-origin">
              {sourceLabel[initial.source]()}
            </Badge>
          </FieldLabel>
          <Input
            id="release-source"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder={initial.effectiveUrl}
            aria-invalid={error ? true : undefined}
            className="font-mono text-sm"
            data-testid="release-source"
          />
        </Field>
      </CardContent>
      <SaveBar
        dirty={url.trim() !== initial.url}
        pending={save.isPending}
        error={error}
        testId="release-source-save"
      />
    </form>
  );
}
