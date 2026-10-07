import { Loader as AppicaLoader } from "@appica/ui-react/loader";
import type * as React from "react";
import { AppicaScope } from "@/components/appica/scope";

/**
 * appica's loader in the action blue's ink: the dark preset blue (a button fill) sits near 2:1 on
 * the dark canvas, its ink reads.
 */
export function Loader({
  label,
  ...props
}: Omit<React.ComponentProps<typeof AppicaLoader>, "aria-label"> & { label: string }) {
  return (
    <AppicaScope className="[--primary:var(--primary-ink)]">
      <AppicaLoader aria-label={label} {...props} />
    </AppicaScope>
  );
}
