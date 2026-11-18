import type { ReactNode } from "react";

export function WorkspaceOverview({
  status,
  main,
  aside,
}: {
  status: ReactNode;
  main?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="grid items-start gap-4 @[72rem]/main:grid-cols-[minmax(0,1fr)_20rem] @[72rem]/main:grid-rows-[auto_1fr]">
      <div className="min-w-0 @[72rem]/main:col-start-2 @[72rem]/main:row-start-1">{status}</div>
      <div className="grid min-w-0 gap-4 @[72rem]/main:col-start-1 @[72rem]/main:row-span-2 @[72rem]/main:row-start-1">
        {main}
      </div>
      <div className="grid min-w-0 gap-4 @[72rem]/main:col-start-2 @[72rem]/main:row-start-2">
        {aside}
      </div>
    </div>
  );
}
