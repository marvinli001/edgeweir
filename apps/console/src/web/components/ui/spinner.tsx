import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { m } from "@/lib/i18n";

function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={2}
      data-slot="spinner"
      role="status"
      aria-label={m.common_loading()}
      // Busy state: it keeps turning under reduced motion, slower.
      className={cn(
        "size-4 animate-spin motion-reduce:animate-[spin_2s_linear_infinite]",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
