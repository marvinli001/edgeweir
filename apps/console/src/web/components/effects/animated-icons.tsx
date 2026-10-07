/*
 * Animated icons: adapted from hugeicons-animated (MIT, Abdullah Enes Gules; glyphs from the
 * Hugeicons free set; THIRD-PARTY-NOTICES.md). Changes: stroke width 2 to match the static icons,
 * sized by CSS like HugeiconsIcon, and played by the row they sit in (`useIconPlay`) instead of
 * their own hover. Reduced motion never plays them.
 */
import { useAnimation, type Variants } from "motion/react";
import * as motion from "motion/react-m";
import * as React from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

export interface IconPlayer {
  play: () => void;
}

/** Plays an icon when its row is hovered: spread `trigger` on the row, pass `ref` to the icon. */
export function useIconPlay() {
  const ref = React.useRef<IconPlayer>(null);
  const trigger = React.useMemo(
    () => ({ onMouseEnter: () => ref.current?.play(), onFocus: () => ref.current?.play() }),
    [],
  );
  return { ref, trigger };
}

type Controls = ReturnType<typeof useAnimation>;

function useIconControls(ref: React.ForwardedRef<IconPlayer>): Controls {
  const controls = useAnimation();
  const reduced = useReducedMotion();
  const playing = React.useRef(false);
  React.useImperativeHandle(
    ref,
    () => ({
      play: () => {
        if (reduced || playing.current) return;
        playing.current = true;
        controls.set("normal");
        void controls.start("animate").then(() => {
          playing.current = false;
        });
      },
    }),
    [controls, reduced],
  );
  return controls;
}

const stroke = {
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Svg({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.svg> & { className?: string }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      fill="none"
      overflow="visible"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      {children}
    </motion.svg>
  );
}

const tileVariants: Variants = {
  normal: { transform: "scale(1)" },
  animate: (i: number) => ({
    transform: [
      "translateY(1.4px) scale(0.74)",
      "translateY(-0.4px) scale(1.1)",
      "translateY(0px) scale(1)",
    ],
    transition: { duration: 0.48, delay: i * 0.06, ease: [0.23, 1, 0.32, 1] },
  }),
};

const TILES = [
  {
    d: "M3.1903 8.95671C3 8.49728 3 7.91485 3 6.75C3 5.58515 3 5.00272 3.1903 4.54329C3.44404 3.93072 3.93072 3.44404 4.54329 3.1903C5.00272 3 5.58515 3 6.75 3C7.91485 3 8.49728 3 8.95671 3.1903C9.56928 3.44404 10.056 3.93072 10.3097 4.54329C10.5 5.00272 10.5 5.58515 10.5 6.75C10.5 7.91485 10.5 8.49728 10.3097 8.95671C10.056 9.56928 9.56928 10.056 8.95671 10.3097C8.49728 10.5 7.91485 10.5 6.75 10.5C5.58515 10.5 5.00272 10.5 4.54329 10.3097C3.93072 10.056 3.44404 9.56928 3.1903 8.95671Z",
    origin: "6.75px 6.75px",
  },
  {
    d: "M13.6903 8.95671C13.5 8.49728 13.5 7.91485 13.5 6.75C13.5 5.58515 13.5 5.00272 13.6903 4.54329C13.944 3.93072 14.4307 3.44404 15.0433 3.1903C15.5027 3 16.0851 3 17.25 3C18.4149 3 18.9973 3 19.4567 3.1903C20.0693 3.44404 20.556 3.93072 20.8097 4.54329C21 5.00272 21 5.58515 21 6.75C21 7.91485 21 8.49728 20.8097 8.95671C20.556 9.56928 20.0693 10.056 19.4567 10.3097C18.9973 10.5 18.4149 10.5 17.25 10.5C16.0851 10.5 15.5027 10.5 15.0433 10.3097C14.4307 10.056 13.944 9.56928 13.6903 8.95671Z",
    origin: "17.25px 6.75px",
  },
  {
    d: "M3.1903 19.4567C3 18.9973 3 18.4149 3 17.25C3 16.0851 3 15.5027 3.1903 15.0433C3.44404 14.4307 3.93072 13.944 4.54329 13.6903C5.00272 13.5 5.58515 13.5 6.75 13.5C7.91485 13.5 8.49728 13.5 8.95671 13.6903C9.56928 13.944 10.056 14.4307 10.3097 15.0433C10.5 15.5027 10.5 16.0851 10.5 17.25C10.5 18.4149 10.5 18.9973 10.3097 19.4567C10.056 20.0693 9.56928 20.556 8.95671 20.8097C8.49728 21 7.91485 21 6.75 21C5.58515 21 5.00272 21 4.54329 20.8097C3.93072 20.556 3.44404 20.0693 3.1903 19.4567Z",
    origin: "6.75px 17.25px",
  },
  {
    d: "M13.6903 19.4567C13.5 18.9973 13.5 18.4149 13.5 17.25C13.5 16.0851 13.5 15.5027 13.6903 15.0433C13.944 14.4307 14.4307 13.944 15.0433 13.6903C15.5027 13.5 16.0851 13.5 17.25 13.5C18.4149 13.5 18.9973 13.5 19.4567 13.6903C20.0693 13.944 20.556 14.4307 20.8097 15.0433C21 15.5027 21 16.0851 21 17.25C21 18.4149 21 18.9973 20.8097 19.4567C20.556 20.0693 20.0693 20.556 19.4567 20.8097C18.9973 21 18.4149 21 17.25 21C16.0851 21 15.5027 21 15.0433 20.8097C14.4307 20.556 13.944 20.0693 13.6903 19.4567Z",
    origin: "17.25px 17.25px",
  },
];

export const DashboardIcon = React.forwardRef<IconPlayer, { className?: string }>(
  function DashboardIcon({ className }, ref) {
    const controls = useIconControls(ref);
    return (
      <Svg className={className}>
        {TILES.map((tile, i) => (
          <motion.path
            key={tile.origin}
            d={tile.d}
            {...stroke}
            strokeLinecap="square"
            variants={tileVariants}
            custom={i}
            animate={controls}
            initial="normal"
            style={{ transformOrigin: tile.origin }}
          />
        ))}
      </Svg>
    );
  },
);

const bellVariants: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -14, 11, -8, 5, -2, 0],
    transition: { duration: 0.9, ease: "easeInOut", times: [0, 0.18, 0.38, 0.56, 0.72, 0.87, 1] },
  },
};

const clapperVariants: Variants = {
  normal: { translateX: 0 },
  animate: {
    translateX: [0, 2.2, -1.8, 1.2, -0.7, 0.3, 0],
    transition: { duration: 0.9, ease: "easeInOut", times: [0, 0.24, 0.44, 0.62, 0.78, 0.9, 1] },
  },
};

export const BellIcon = React.forwardRef<IconPlayer, { className?: string }>(function BellIcon(
  { className },
  ref,
) {
  const controls = useIconControls(ref);
  return (
    <Svg
      className={className}
      variants={bellVariants}
      animate={controls}
      initial="normal"
      style={{ transformOrigin: "top center" }}
    >
      <path
        d="M20 18.5011L18.349 7.93407C17.8603 4.80601 15.166 2.5 12 2.5C8.83398 2.5 6.13971 4.80601 5.65098 7.93407L4 18.5011"
        {...stroke}
      />
      <path
        d="M20 18.5C20 16.8431 16.4183 15.5 12 15.5C7.58172 15.5 4 16.8431 4 18.5C4 20.1569 7.58172 21.5 12 21.5C16.4183 21.5 20 20.1569 20 18.5Z"
        {...stroke}
      />
      <motion.path
        d="M13 18.5H11"
        {...stroke}
        variants={clapperVariants}
        animate={controls}
        initial="normal"
      />
    </Svg>
  );
});

const knobVariants: Variants = {
  normal: { transform: "translateX(0px)" },
  animate: (i: number) => ({
    transform: [
      "translateX(0px)",
      i === 0 ? "translateX(-2.8px)" : i === 1 ? "translateX(3px)" : "translateX(-2.4px)",
      i === 0 ? "translateX(0.45px)" : i === 1 ? "translateX(-0.45px)" : "translateX(0.4px)",
      "translateX(0px)",
    ],
    transition: { duration: 0.48, delay: i * 0.07, ease: [0.23, 1, 0.32, 1] },
  }),
};

export const SlidersIcon = React.forwardRef<IconPlayer, { className?: string }>(
  function SlidersIcon({ className }, ref) {
    const controls = useIconControls(ref);
    const knob = (d: string, i: number, origin: string) => (
      <motion.path
        d={d}
        {...stroke}
        variants={knobVariants}
        custom={i}
        animate={controls}
        initial="normal"
        style={{ transformOrigin: origin }}
      />
    );
    return (
      <Svg className={className}>
        <path d="M3.99963 5.00055L9.99963 5.00031" {...stroke} />
        <path d="M12.9996 5.00031L19.9996 5.00031" {...stroke} />
        {knob("M15.9996 9.00031L15.9996 15.0003", 0, "16px 12px")}
        {knob("M9.99963 2.00031L9.99963 8.00031", 1, "10px 5px")}
        {knob("M11.9996 16.0003L11.9996 22.0003", 2, "12px 19px")}
        <path d="M15.9996 12.0001L19.9996 12.0003" {...stroke} />
        <path d="M3.99963 12.0005L12.9996 12.0003" {...stroke} />
        <path d="M11.9996 19.0003L19.9996 19.0003" {...stroke} />
        <path d="M3.99963 19.0005L8.99963 19.0003" {...stroke} />
      </Svg>
    );
  },
);

const rowVariants: Variants = {
  normal: { transform: "scaleX(1)" },
  animate: (i: number) => ({
    transform: ["scaleX(1)", "scaleX(0.68)", "scaleX(1.04)", "scaleX(0.98)", "scaleX(1)"],
    transition: {
      duration: 0.44,
      delay: i * 0.06,
      ease: [0.77, 0, 0.175, 1],
      times: [0, 0.28, 0.56, 0.76, 1],
    },
  }),
};

const ROWS = [
  {
    d: "M2 3.4C2 2.24173 2.24173 2 3.4 2H20.6C21.7583 2 22 2.24173 22 3.4V4.6C22 5.75827 21.7583 6 20.6 6H3.4C2.24173 6 2 5.75827 2 4.6V3.4Z",
    origin: [2 / 24, 4 / 24],
  },
  {
    d: "M2 11.4C2 10.2417 2.24173 10 3.4 10H20.6C21.7583 10 22 10.2417 22 11.4V12.6C22 13.7583 21.7583 14 20.6 14H3.4C2.24173 14 2 13.7583 2 12.6V11.4Z",
    origin: [22 / 24, 12 / 24],
  },
  {
    d: "M2 19.4C2 18.2417 2.24173 18 3.4 18H20.6C21.7583 18 22 18.2417 22 19.4V20.6C22 21.7583 21.7583 22 20.6 22H3.4C2.24173 22 2 21.7583 2 20.6V19.4Z",
    origin: [2 / 24, 20 / 24],
  },
] as const;

export const ListIcon = React.forwardRef<IconPlayer, { className?: string }>(function ListIcon(
  { className },
  ref,
) {
  const controls = useIconControls(ref);
  return (
    <Svg className={className}>
      {ROWS.map((row, i) => (
        <motion.path
          key={row.d}
          d={row.d}
          {...stroke}
          variants={rowVariants}
          custom={i}
          animate={controls}
          initial="normal"
          style={{ transformBox: "view-box", originX: row.origin[0], originY: row.origin[1] }}
        />
      ))}
    </Svg>
  );
});

const inboxVariants: Variants = {
  normal: { transform: "scaleY(1)" },
  animate: {
    transform: ["scaleY(1)", "scaleY(1.025)", "scaleY(0.94)", "scaleY(1)"],
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1], times: [0, 0.3, 0.58, 1] },
  },
};

const trayVariants: Variants = {
  normal: { transform: "translateY(0px)" },
  animate: {
    transform: [
      "translateY(-1.6px)",
      "translateY(1.15px)",
      "translateY(-0.25px)",
      "translateY(0px)",
    ],
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1], times: [0, 0.5, 0.78, 1] },
  },
};

export const InboxIcon = React.forwardRef<IconPlayer, { className?: string }>(function InboxIcon(
  { className },
  ref,
) {
  const controls = useIconControls(ref);
  return (
    <Svg className={className}>
      <motion.path
        d="M2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12Z"
        {...stroke}
        variants={inboxVariants}
        animate={controls}
        initial="normal"
        style={{ transformOrigin: "12px 18px" }}
      />
      <motion.path
        d="M21.5 13.5H16.5743C15.7322 13.5 15.0706 14.2036 14.6995 14.9472C14.2963 15.7551 13.4889 16.5 12 16.5C10.5111 16.5 9.70373 15.7551 9.30054 14.9472C8.92942 14.2036 8.26777 13.5 7.42566 13.5H2.5"
        {...stroke}
        variants={trayVariants}
        animate={controls}
        initial="normal"
        style={{ transformOrigin: "12px 14px" }}
      />
    </Svg>
  );
});
