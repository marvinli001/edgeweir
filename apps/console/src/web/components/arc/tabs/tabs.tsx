/*
 * Tabs: ported from Arc's `tabs` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md), the primitive
 * switched from Radix to Base UI. Changes: the gliding selection is Base UI's Tabs.Indicator, which
 * measures the active tab, moving on Arc's spring curve in CSS instead of a Motion layoutId; the
 * incoming panel slides in from the side Base UI reports (data-activation-direction) without the
 * height morph or the outgoing panel; the overflow scroll buttons are left out (segmented lists
 * here are short, and the page tab bars scroll themselves); a `line` variant for page tab bars and
 * a vertical orientation, as the console's tabs had; `--arc-` tokens (foundation.css), the
 * console's focus ring, and the module sits in Tailwind's components layer.
 */
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";
import styles from "./tabs.module.css";

type ClassName = { className?: string };

export function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: Omit<TabsPrimitive.Root.Props, "className"> & ClassName) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(styles.root, className)}
      {...props}
    />
  );
}

/**
 * A segmented control (the selection glides under the active tab) or, with `variant="line"`, a
 * page tab bar with a bar under the active tab.
 */
export function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: Omit<TabsPrimitive.List.Props, "className"> & ClassName & { variant?: "default" | "line" }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(styles.list, className)}
      {...props}
    >
      {children}
      {variant === "default" ? (
        <TabsPrimitive.Indicator data-slot="tabs-indicator" className={styles.selection} />
      ) : null}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({
  className,
  children,
  ...props
}: Omit<TabsPrimitive.Tab.Props, "className"> & ClassName) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(styles.trigger, className)}
      {...props}
    >
      {children}
    </TabsPrimitive.Tab>
  );
}

export function TabsContent({
  className,
  ...props
}: Omit<TabsPrimitive.Panel.Props, "className"> & ClassName) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(styles.content, className)}
      {...props}
    />
  );
}
