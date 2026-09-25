import { Loader as AppicaLoader } from "@appica/ui-react/loader";
import type * as React from "react";
import { AppicaScope } from "@/components/appica/scope";

export function Loader({
  label,
  ...props
}: Omit<React.ComponentProps<typeof AppicaLoader>, "aria-label"> & { label: string }) {
  return (
    <AppicaScope>
      <AppicaLoader aria-label={label} {...props} />
    </AppicaScope>
  );
}
