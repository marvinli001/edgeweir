import type { WafSettings } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** Admin card: whether tenants may turn on OWASP CRS for their sites. */
export function WafSettingsCard() {
  const query = useQuery(orpc.settings.waf.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "190ms" }}>
      <CardHeader>
        <CardTitle>{m.system_waf_title()}</CardTitle>
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
        <WafSettingsForm key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
  );
}

function WafSettingsForm({ initial }: { initial: WafSettings }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setWaf.mutationOptions());
  const [tenantCrs, setTenantCrs] = React.useState(initial.tenantCrs);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await save.mutateAsync({ tenantCrs });
          await queryClient.invalidateQueries({ queryKey: orpc.settings.waf.key() });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent>
        <SwitchField
          id="waf-tenant-crs"
          label={m.system_waf_tenant_crs()}
          checked={tenantCrs}
          onCheckedChange={setTenantCrs}
          testId="waf-tenant-crs"
        />
      </CardContent>
      <SaveBar
        dirty={tenantCrs !== initial.tenantCrs}
        pending={save.isPending}
        error={error}
        testId="waf-settings-save"
      />
    </form>
  );
}
