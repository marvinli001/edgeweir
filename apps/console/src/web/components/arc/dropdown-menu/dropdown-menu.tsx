/*
 * DropdownMenu: ported from Arc's `dropdown-menu` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md),
 * the primitive switched from Radix to Base UI's Menu. Changes: the console's compound parts
 * (groups, labels, checkbox and radio items, submenus, a destructive item) instead of an `items`
 * array, so the trigger is the caller's (Arc's animated trigger label and chevron are left out);
 * the one gliding highlight follows Base UI's data-highlighted; transitions key off Base UI's
 * data-starting-style / data-ending-style and its --transform-origin; Motion's light components
 * through components/effects/motion, the console's reduced-motion hook, Hugeicons instead of
 * Lucide, `--arc-` tokens (foundation.css), and the module sits in Tailwind's components layer.
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { motion } from "@/components/effects/motion";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./dropdown-menu.module.css";

type ClassName = { className?: string };
type Highlight = { top: number; height: number; danger: boolean; glide: boolean };

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

export function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

export function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

export function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  className,
  children,
  ...props
}: Omit<MenuPrimitive.Popup.Props, "className"> &
  ClassName &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  const reduced = useReducedMotion();
  // The popup mounts only while open, so the effect follows the node rather than a ref.
  const [menu, setMenu] = useState<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  // The pointer glides the highlight between items; the keyboard moves it at once.
  const pointer = useRef(false);
  useEffect(() => {
    setHighlight(null);
    if (!menu) return;
    // Items rise in one after another (the first five), so number them for the stagger.
    for (const [index, item] of [...menu.querySelectorAll<HTMLElement>(ITEM)].entries()) {
      item.style.setProperty("--i", String(index));
    }
    const follow = () => {
      const item = [...menu.querySelectorAll<HTMLElement>("[data-highlighted]")].find(
        (node) => node.closest("[data-slot=dropdown-menu-content]") === menu,
      );
      setHighlight((current) =>
        item
          ? {
              top: item.offsetTop,
              height: item.offsetHeight,
              danger: item.dataset.variant === "destructive",
              glide: pointer.current && current !== null,
            }
          : null,
      );
    };
    const observer = new MutationObserver(follow);
    observer.observe(menu, { subtree: true, attributeFilter: ["data-highlighted"] });
    return () => observer.disconnect();
  }, [menu]);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className={styles.positioner}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={12}
      >
        <MenuPrimitive.Popup
          ref={setMenu}
          data-slot="dropdown-menu-content"
          className={cn(styles.menu, className)}
          onPointerMoveCapture={() => {
            pointer.current = true;
          }}
          onKeyDownCapture={() => {
            pointer.current = false;
          }}
          {...props}
        >
          <motion.span
            className={styles.highlight}
            data-tone={highlight?.danger ? "danger" : undefined}
            aria-hidden="true"
            initial={false}
            animate={
              highlight
                ? { y: highlight.top, height: highlight.height, opacity: 1 }
                : { opacity: 0 }
            }
            transition={{
              default: highlight?.glide && !reduced ? motionTokens.spring.snappy : { duration: 0 },
              opacity: { duration: reduced ? 0 : 0.08 },
            }}
          />
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: Omit<MenuPrimitive.GroupLabel.Props, "className"> & ClassName & { inset?: boolean }) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(styles.label, className)}
      {...props}
    />
  );
}

export function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: Omit<MenuPrimitive.Item.Props, "className"> &
  ClassName & { inset?: boolean; variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(styles.item, className)}
      {...props}
    />
  );
}

export function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: Omit<MenuPrimitive.SubmenuTrigger.Props, "className"> & ClassName & { inset?: boolean }) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(styles.item, className)}
      {...props}
    >
      {children}
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className={styles.chevron} />
    </MenuPrimitive.SubmenuTrigger>
  );
}

export function DropdownMenuSubContent({
  align = "start",
  alignOffset = -6,
  side = "right",
  sideOffset = 0,
  ...props
}: ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-sub=""
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  inset,
  ...props
}: Omit<MenuPrimitive.CheckboxItem.Props, "className"> & ClassName & { inset?: boolean }) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(styles.item, styles.checkable, className)}
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator className={styles.indicator}>
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
      </MenuPrimitive.CheckboxItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: Omit<MenuPrimitive.RadioItem.Props, "className"> & ClassName & { inset?: boolean }) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(styles.item, styles.checkable, className)}
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator className={styles.indicator}>
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
      </MenuPrimitive.RadioItemIndicator>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: Omit<MenuPrimitive.Separator.Props, "className"> & ClassName) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(styles.separator, className)}
      {...props}
    />
  );
}
