import { Popover as Primitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";
import styles from "./popover.module.css";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

export function PopoverContent({
  align = "start",
  side = "bottom",
  className,
  ...props
}: Omit<Primitive.Popup.Props, "className"> &
  Pick<Primitive.Positioner.Props, "align" | "side"> & { className?: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={10}
        className={styles.positioner}
      >
        <Primitive.Popup className={cn(styles.popup, className)} {...props} />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
