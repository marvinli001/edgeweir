import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A busy indicator in the current text color; it keeps turning under reduced motion, slower. */
function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={2}
      data-slot="spinner"
      role="status"
      aria-label={m.common_loading()}
      className={cn(
        "size-4 animate-spin motion-reduce:animate-[spin_2s_linear_infinite]",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
