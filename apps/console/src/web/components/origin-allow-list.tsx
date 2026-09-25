import { MAX_ORIGIN_ALLOWED_CIDRS, normalizeCidr } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SafetyNote } from "@/components/safety-note";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const lines = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Admin card: special-purpose addresses (private, loopback, link-local...) that
 * origins may use anyway. Saving publishes a new revision for every cluster.
 */
export function OriginAllowListCard() {
  const list = useQuery(orpc.settings.originAllowList.queryOptions());
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "40ms" }}
      data-testid="origin-allow-list-card"
    >
      <CardHeader>
        <CardTitle>{m.system_origin_allow_list_title()}</CardTitle>
      </CardHeader>
      {list.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : list.isError ? (
        <CardContent>
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        </CardContent>
      ) : (
        <AllowListForm key={list.data.cidrs.join(",")} initial={list.data.cidrs} />
      )}
    </Card>
  );
}

function AllowListForm({ initial }: { initial: string[] }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setOriginAllowList.mutationOptions());
  const [text, setText] = React.useState(initial.join("\n"));
  const [error, setError] = React.useState<string | null>(null);
  const entries = lines(text);
  const dirty = entries.join("\n") !== initial.join("\n");

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const invalid = entries.find((entry) => normalizeCidr(entry) === null);
    if (invalid !== undefined) {
      setError(m.system_origin_allow_list_invalid({ value: invalid }));
      return;
    }
    if (entries.length > MAX_ORIGIN_ALLOWED_CIDRS) {
      setError(m.system_origin_allow_list_too_many({ max: MAX_ORIGIN_ALLOWED_CIDRS }));
      return;
    }
    setError(null);
    try {
      const saved = await save.mutateAsync({ cidrs: entries });
      setText(saved.cidrs.join("\n"));
      await queryClient.invalidateQueries({ queryKey: orpc.settings.originAllowList.key() });
      toast.success(m.common_saved());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <form className="flex flex-col gap-(--card-spacing)" onSubmit={onSubmit} noValidate>
      <CardContent className="flex flex-col gap-3">
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="origin-allow-list">{m.system_origin_allow_list_label()}</FieldLabel>
          <Textarea
            id="origin-allow-list"
            value={text}
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            placeholder={"10.0.0.0/8\n172.18.0.0/16\nfd00::/8"}
            aria-invalid={error ? true : undefined}
            className="min-h-28 font-mono text-sm"
            data-testid="origin-allow-list"
          />
        </Field>
        <SafetyNote>{m.system_origin_allow_list_note()}</SafetyNote>
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-3 border-t">
        {error ? (
          <FieldError className="mr-auto animate-in fade-in" data-testid="origin-allow-list-error">
            {error}
          </FieldError>
        ) : null}
        <Button
          type="submit"
          disabled={!dirty || save.isPending}
          data-testid="origin-allow-list-save"
        >
          {save.isPending ? <Spinner /> : null}
          {m.common_save()}
        </Button>
      </CardFooter>
    </form>
  );
}
