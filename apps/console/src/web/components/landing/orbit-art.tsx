/**
 * Flat, softly shaded illustrations for the Orbit template (navy, sky blue and
 * an orange-to-pink accent). Everything is decorative (aria-hidden) and every
 * animation class is disabled under prefers-reduced-motion (landing.css).
 */
import * as React from "react";
import { fallbackPlace, placeOf } from "@/lib/places";
import { hashUnit } from "./shared";
import { landPaths, type Projection, project } from "./world";

const NAVY = "#183d6d";

function useIds<T extends string>(...names: T[]): Record<T, string> {
  const base = React.useId().replace(/:/g, "");
  return Object.fromEntries(names.map((n) => [n, `${base}-${n}`])) as Record<T, string>;
}

/** The weir mark from the logo, drawn inside other art. */
function Mark({ x, y, size, color }: { x: number; y: number; size: number; color: string }) {
  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      overflow="visible"
      aria-hidden="true"
    >
      <g stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 3 2" />
        <path d="M3 21c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 3 2" />
        <path d="M4 12 12 4l8 8" />
      </g>
    </svg>
  );
}

/** A map pin standing on (x, y). */
function Pin({
  x,
  y,
  size = 30,
  fill,
  delay = 0,
  title,
}: {
  x: number;
  y: number;
  size?: number;
  fill: string;
  delay?: number;
  title?: string;
}) {
  const s = size / 44;
  return (
    <g transform={`translate(${x} ${y})`}>
      {title ? <title>{title}</title> : null}
      <ellipse cx={0} cy={0} rx={9 * s} ry={3.2 * s} fill="#0b1640" opacity={0.28} />
      <g className="landing-bob" style={{ animationDelay: `${delay}s` }}>
        <g transform={`scale(${s}) translate(0 -44)`}>
          <path
            d="M0 0C12 0 20 8.6 20 18.5 20 31 0 44 0 44S-20 31-20 18.5C-20 8.6-12 0 0 0Z"
            fill={fill}
          />
          <path
            d="M-12 8C-8 3.5-3.5 2-0.5 2"
            stroke="#fff"
            strokeOpacity={0.55}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
          />
          <circle cy={18.5} r={8} fill="#26275f" />
        </g>
      </g>
    </g>
  );
}

function Star({ x, y, size, delay = 0 }: { x: number; y: number; size: number; delay?: number }) {
  const points = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? size : size * 0.48;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
  }).join(" ");
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className="landing-spin-slow" style={{ animationDelay: `${delay}s` }}>
        <polygon
          points={points}
          fill="#ff9d42"
          stroke="#ffbd6e"
          strokeWidth={size * 0.12}
          strokeLinejoin="round"
        />
      </g>
    </g>
  );
}

/**
 * The rocket, nose up at (0, 0) = centre of its body; place it with a transform.
 * `smoke` adds the puffy exhaust trail.
 */
function RocketBody({ smoke = true }: { smoke?: boolean }) {
  const id = useIds("body", "nose", "glass", "flame", "flameCore", "fin", "puff", "band");
  return (
    <g>
      <defs>
        <linearGradient id={id.body} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f2f8ff" />
          <stop offset="0.35" stopColor="#9ccaf8" />
          <stop offset="0.7" stopColor="#4d8ae6" />
          <stop offset="1" stopColor="#2a55b8" />
        </linearGradient>
        <linearGradient id={id.nose} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc15a" />
          <stop offset="1" stopColor="#ff5f45" />
        </linearGradient>
        <radialGradient id={id.glass} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#3a4a9a" />
          <stop offset="1" stopColor="#11173f" />
        </radialGradient>
        <linearGradient id={id.flame} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff0b8" />
          <stop offset="0.3" stopColor="#ffb347" />
          <stop offset="0.75" stopColor="#ff5f6d" />
          <stop offset="1" stopColor="#ff5f6d" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id.flameCore} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffe29a" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id.fin} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a67d1" />
          <stop offset="1" stopColor="#1b2f75" />
        </linearGradient>
        <radialGradient id={id.puff} cx="0.35" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#fffaf2" />
          <stop offset="0.6" stopColor="#ffe3c4" />
          <stop offset="1" stopColor="#f7b98f" />
        </radialGradient>
        <linearGradient id={id.band} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3c5cc4" />
          <stop offset="1" stopColor="#15225e" />
        </linearGradient>
      </defs>
      {smoke ? (
        <g className="landing-puff">
          {[
            [6, 196, 30],
            [-26, 226, 36],
            [22, 246, 30],
            [-6, 272, 40],
          ].map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={`url(#${id.puff})`} />
          ))}
        </g>
      ) : null}
      <g className="landing-flame">
        <path d="M-30 96C-30 150-12 190 0 214 12 190 30 150 30 96Z" fill={`url(#${id.flame})`} />
        <path d="M-14 96C-14 128-6 150 0 164 6 150 14 128 14 96Z" fill={`url(#${id.flameCore})`} />
      </g>
      <path d="M-44 40C-78 58-92 92-90 128L-40 96Z" fill={`url(#${id.fin})`} />
      <path d="M44 40C78 58 92 92 90 128L40 96Z" fill={`url(#${id.fin})`} />
      <path d="M-74 84-66 74-50 86-56 96Z" fill="#ff9d42" />
      <path d="M74 84 66 74 50 86 56 96Z" fill="#ff9d42" />
      <path d="M-26 86H26L20 104H-20Z" fill="#1b2f75" />
      <path
        d="M0-150C46-112 60-40 50 88H-50C-60-40-46-112 0-150Z"
        fill={`url(#${id.body})`}
        stroke="#1d3478"
        strokeOpacity={0.35}
        strokeWidth={2}
      />
      <path
        d="M-30-20C-34 20-32 52-26 84M-14-90C-20-50-20-10-16 30"
        stroke="#fff"
        strokeOpacity={0.55}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      <path d="M0-150C24-131 38-104 45-74H-45C-38-104-24-131 0-150Z" fill={`url(#${id.nose})`} />
      <path d="M-50 58H50L50 88H-50Z" fill={`url(#${id.band})`} />
      <circle cy={-16} r={31} fill="#ffb347" stroke="#ff7a3d" strokeWidth={3} />
      <circle cy={-16} r={22} fill={`url(#${id.glass})`} />
      <Mark x={-12} y={-30} size={24} color="#ff9d42" />
      <path
        d="M-14-28A18 18 0 0 1 2-35"
        stroke="#fff"
        strokeOpacity={0.7}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
}

/** Hero: a planet with pins and a ring, and the rocket leaving a trail of smoke. */
export function HeroArt() {
  const id = useIds("planet", "shade", "rim", "glow", "clip", "moon");
  const cx = 420;
  const cy = 290;
  const r = 205;
  return (
    <svg viewBox="0 0 680 640" className="h-auto w-full" aria-hidden="true" overflow="visible">
      <defs>
        <radialGradient id={id.planet} cx="0.32" cy="0.26" r="0.9">
          <stop offset="0" stopColor="#7a78f6" />
          <stop offset="0.42" stopColor="#4146b9" />
          <stop offset="0.78" stopColor="#262b7a" />
          <stop offset="1" stopColor="#191d55" />
        </radialGradient>
        <linearGradient id={id.shade} x1="0.2" y1="0.1" x2="0.9" y2="0.95">
          <stop offset="0.45" stopColor="#0b0f35" stopOpacity="0" />
          <stop offset="1" stopColor="#0b0f35" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id={id.rim} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b9b8ff" stopOpacity="0.9" />
          <stop offset="0.5" stopColor="#8e8cff" stopOpacity="0.15" />
          <stop offset="1" stopColor="#8e8cff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={id.glow}>
          <stop offset="0.55" stopColor="#6e62ff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#6e62ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id.moon} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#ffd08a" />
          <stop offset="1" stopColor="#ff7a3d" />
        </radialGradient>
        <clipPath id={id.clip}>
          <circle cx={cx} cy={cy} r={r} />
        </clipPath>
      </defs>

      <circle cx={cx} cy={cy} r={r * 1.35} fill={`url(#${id.glow})`} />
      <g transform={`rotate(-16 ${cx} ${cy})`}>
        <path
          d={`M${cx - 300} ${cy}A300 66 0 0 1 ${cx + 300} ${cy}`}
          fill="none"
          stroke="#a9a7ff"
          strokeOpacity={0.28}
          strokeWidth={10}
        />
      </g>

      <g className="landing-float-slow">
        <circle cx={cx} cy={cy} r={r} fill={`url(#${id.planet})`} />
        <g clipPath={`url(#${id.clip})`}>
          <path
            d="M300 170c40-38 96-40 130-16s40 60 86 58 70 30 60 64-58 42-96 30-62 14-98 2-60-44-80-78-40-26-2-60Z"
            fill="#5a5fd6"
            opacity={0.55}
          />
          <path
            d="M260 330c30-10 70 6 90 30s6 60-24 74-72 4-86-26-10-70 20-78Z"
            fill="#5a5fd6"
            opacity={0.45}
          />
          <path
            d="M480 360c34-14 84-8 104 16s-8 58-44 62-66-10-76-34 0-36 16-44Z"
            fill="#3d44ad"
            opacity={0.6}
          />
          <path
            d="M340 130c20-10 44-8 54 4"
            stroke="#b9b8ff"
            strokeOpacity={0.5}
            strokeWidth={6}
            strokeLinecap="round"
            fill="none"
          />
          <circle cx={cx} cy={cy} r={r} fill={`url(#${id.shade})`} />
        </g>
        <circle cx={cx} cy={cy} r={r - 2} fill="none" stroke={`url(#${id.rim})`} strokeWidth={4} />
        <Pin x={500} y={160} size={46} fill="url(#landing-pin)" delay={0} />
        <Pin x={445} y={236} size={40} fill="url(#landing-pin)" delay={0.6} />
        <Pin x={560} y={262} size={36} fill="url(#landing-pin)" delay={1.2} />
        <Pin x={372} y={178} size={30} fill="url(#landing-pin)" delay={1.8} />
      </g>

      <g transform={`rotate(-16 ${cx} ${cy})`}>
        <path
          d={`M${cx + 300} ${cy}A300 66 0 0 1 ${cx - 300} ${cy}`}
          fill="none"
          stroke="#b7b5ff"
          strokeOpacity={0.55}
          strokeWidth={10}
        />
        <circle cx={cx + 212} cy={cy + 48} r={16} fill={`url(#${id.moon})`} />
        <circle cx={cx + 207} cy={cy + 44} r={4} fill="#e8662f" opacity={0.6} />
      </g>

      <g transform="translate(300 370) rotate(38) scale(0.82)">
        <g className="landing-float">
          <RocketBody />
        </g>
      </g>

      <Star x={640} y={70} size={22} />
      <Star x={620} y={560} size={18} delay={1.4} />
      <Star x={70} y={600} size={13} delay={0.7} />
      {[
        [120, 90, 2],
        [560, 30, 1.6],
        [30, 300, 1.8],
        [660, 420, 2],
        [210, 200, 1.4],
      ].map(([x, y, rr], i) => (
        <circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r={rr}
          fill="#fff"
          className="landing-twinkle"
          style={{ animationDelay: `${i * 0.7}s` }}
        />
      ))}
      <PinGradient />
    </svg>
  );
}

/** Shared gradient for pins (one per document is enough). */
function PinGradient() {
  return (
    <defs>
      <linearGradient id="landing-pin" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffb14a" />
        <stop offset="1" stopColor="#ff5f45" />
      </linearGradient>
    </defs>
  );
}

/** A small rocket with a long trail, for the edges of the hero. */
export function Comet({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const id = useIds("trail");
  return (
    <svg
      viewBox="0 0 220 80"
      className={className}
      style={style}
      aria-hidden="true"
      overflow="visible"
    >
      <defs>
        <linearGradient id={id.trail} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff7a3d" stopOpacity="0" />
          <stop offset="1" stopColor="#ff8a3d" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <path d="M0 40Q90 26 150 34L150 46Q90 54 0 40Z" fill={`url(#${id.trail})`} />
      <g transform="translate(170 40)">
        <path d="M-22-10H14C26-10 34-4 36 0 34 4 26 10 14 10H-22Z" fill="#ff8a3d" />
        <path d="M14-10C26-10 34-4 36 0 34 4 26 10 14 10Z" fill="#ffc15a" />
        <path d="M-22-10-32-20-26-8ZM-22 10-32 20-26 8Z" fill="#3f6fd6" />
        <circle cx={2} r={4} fill="#1b2f75" />
      </g>
    </svg>
  );
}

/** Background ringed planet at the hero's left edge. */
export function RingedPlanet({
  className,
  tone = "violet",
}: {
  className?: string;
  tone?: "violet" | "sunset";
}) {
  const id = useIds("body", "ring");
  const [from, to] = tone === "sunset" ? ["#ffb35c", "#ff4d6d"] : ["#6e6bd8", "#2a2d7a"];
  return (
    <svg viewBox="0 0 400 300" className={className} aria-hidden="true" overflow="visible">
      <defs>
        <radialGradient id={id.body} cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </radialGradient>
        <linearGradient id={id.ring} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.15" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.7" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <g transform="rotate(-18 200 150)">
        <path
          d="M40 150A160 42 0 0 1 360 150"
          fill="none"
          stroke={`url(#${id.ring})`}
          strokeWidth={16}
        />
        <circle cx={200} cy={150} r={96} fill={`url(#${id.body})`} />
        <path
          d="M130 120c20-30 60-44 96-34"
          stroke="#fff"
          strokeOpacity={0.3}
          strokeWidth={10}
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M360 150A160 42 0 0 1 40 150"
          fill="none"
          stroke={`url(#${id.ring})`}
          strokeWidth={16}
        />
      </g>
    </svg>
  );
}

/** The rocket on its own, e.g. bursting out of a call-to-action card. */
export function RocketArt({ className, smoke = true }: { className?: string; smoke?: boolean }) {
  return (
    <svg viewBox="-220 -200 440 560" className={className} aria-hidden="true" overflow="visible">
      <g transform="rotate(52)">
        <g className="landing-float">
          <RocketBody smoke={smoke} />
        </g>
      </g>
      <Star x={-170} y={-120} size={14} />
      <Star x={170} y={260} size={11} delay={1} />
    </svg>
  );
}

export type SpotIconId =
  | "cache"
  | "purge"
  | "security"
  | "tls"
  | "observe"
  | "api"
  | "rollback"
  | "regions";

/** 64px spot illustrations for the product cards. */
export function SpotIcon({ id: kind, className }: { id: SpotIconId; className?: string }) {
  const id = useIds("o", "b", "n");
  const defs = (
    <defs>
      <linearGradient id={id.o} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ffb14a" />
        <stop offset="1" stopColor="#ff5f45" />
      </linearGradient>
      <linearGradient id={id.b} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#5b95ea" />
        <stop offset="1" stopColor="#2c5cc0" />
      </linearGradient>
      <linearGradient id={id.n} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#2c4f8c" />
        <stop offset="1" stopColor="#152b52" />
      </linearGradient>
    </defs>
  );
  const o = `url(#${id.o})`;
  const b = `url(#${id.b})`;
  const n = `url(#${id.n})`;
  const art: Record<SpotIconId, React.ReactNode> = {
    cache: (
      <>
        <circle cx={34} cy={36} r={22} fill={n} />
        <path
          d="M20 28c6-2 8 3 13 2s5-7 11-5 4 8-1 10-3 8-9 8-6-6-10-7-8-6-4-8Z"
          fill={b}
          opacity={0.9}
        />
        <path d="M14 40c8 2 14 8 16 16" stroke="#8fc1f2" strokeWidth={1.5} fill="none" />
        <ellipse cx={34} cy={36} rx={9} ry={22} stroke="#8fc1f2" strokeOpacity={0.35} fill="none" />
        <path
          d="M16 12c5 0 8 3.5 8 7.5C24 25 16 31 16 31s-8-6-8-11.5C8 15.5 11 12 16 12Z"
          fill={o}
        />
        <circle cx={16} cy={19.5} r={3} fill="#fff" />
        <path
          d="M50 26c3.5 0 5.5 2.4 5.5 5.2 0 3.8-5.5 8-5.5 8s-5.5-4.2-5.5-8c0-2.8 2-5.2 5.5-5.2Z"
          fill={o}
        />
        <circle cx={50} cy={31} r={2} fill="#fff" />
      </>
    ),
    purge: (
      <>
        {[14, 28, 42].map((y, i) => (
          <g key={y}>
            <rect x={8} y={y} width={38} height={11} rx={3} fill={i === 1 ? b : n} />
            <circle cx={14} cy={y + 5.5} r={2} fill={i === 0 ? "#ffb14a" : "#8fc1f2"} />
            <rect x={30} y={y + 4} width={12} height={3} rx={1.5} fill="#8fc1f2" opacity={0.7} />
          </g>
        ))}
        <path
          d="M58 20a13 13 0 1 1-4-9"
          stroke={o}
          strokeWidth={4.5}
          strokeLinecap="round"
          fill="none"
          transform="translate(-4 12)"
        />
        <path d="M52 12l3 10-10-2Z" fill="#ff7a3d" transform="translate(-4 12)" />
      </>
    ),
    security: (
      <>
        <path d="M32 6 54 14V30C54 44 44 54 32 58 20 54 10 44 10 30V14Z" fill={n} />
        <path d="M32 12 48 18V30C48 40 41 48 32 51Z" fill={b} />
        <path
          d="M22 32l7 7 13-14"
          stroke={o}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </>
    ),
    tls: (
      <>
        <path d="M20 28V20a12 12 0 0 1 24 0v8" stroke="#8fb0d8" strokeWidth={6} fill="none" />
        <rect x={12} y={27} width={40} height={30} rx={6} fill={n} />
        <rect x={12} y={27} width={40} height={8} rx={4} fill={b} opacity={0.8} />
        <circle cx={32} cy={42} r={5} fill={o} />
        <rect x={30} y={44} width={4} height={8} rx={2} fill="#ff7a3d" />
        <path d="M52 10l2 4 4 2-4 2-2 4-2-4-4-2 4-2Z" fill="#ffb14a" />
      </>
    ),
    observe: (
      <>
        <rect x={6} y={10} width={52} height={40} rx={5} fill="#e4f1fd" stroke="#bcd9f4" />
        <path d="M6 15a5 5 0 0 1 5-5h42a5 5 0 0 1 5 5v4H6Z" fill={n} />
        <circle cx={12} cy={14.5} r={1.6} fill="#ff7a3d" />
        <circle cx={17} cy={14.5} r={1.6} fill="#ffb14a" />
        <circle cx={22} cy={14.5} r={1.6} fill="#8fc1f2" />
        <rect x={13} y={32} width={6} height={12} rx={1.5} fill={b} />
        <rect x={23} y={26} width={6} height={18} rx={1.5} fill={o} />
        <rect x={33} y={36} width={6} height={8} rx={1.5} fill={b} />
        <rect x={43} y={24} width={6} height={20} rx={1.5} fill={b} />
        <circle cx={48} cy={50} r={9} fill="#fff" stroke={NAVY} strokeWidth={3} />
        <path d="M54 56l6 6" stroke={NAVY} strokeWidth={4} strokeLinecap="round" />
      </>
    ),
    api: (
      <>
        <rect x={6} y={10} width={46} height={38} rx={6} fill={n} />
        <path
          d="M14 22l7 6-7 6"
          stroke={o}
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <rect x={25} y={31} width={14} height={4} rx={2} fill="#8fc1f2" />
        <rect x={14} y={40} width={26} height={3} rx={1.5} fill="#8fc1f2" opacity={0.5} />
        <g transform="translate(50 46)">
          <circle r={10} fill={o} />
          <circle r={4} fill="#fff" />
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <rect
              key={a}
              x={-2.5}
              y={-13}
              width={5}
              height={5}
              rx={1}
              fill="#ff7a3d"
              transform={`rotate(${a})`}
            />
          ))}
        </g>
      </>
    ),
    rollback: (
      <>
        <path d="M16 14V50M16 22c0 12 30 6 30 20v8" stroke="#8fb0d8" strokeWidth={4} fill="none" />
        <circle cx={16} cy={14} r={7} fill={n} />
        <circle cx={16} cy={50} r={7} fill={b} />
        <circle cx={46} cy={50} r={8} fill={o} />
        <path
          d="M40 12a10 10 0 1 1-4 8"
          stroke={NAVY}
          strokeWidth={3.5}
          strokeLinecap="round"
          fill="none"
        />
        <path d="M33 13l3 8 6-5Z" fill={NAVY} />
      </>
    ),
    regions: (
      <>
        <path d="M32 44 56 32 32 20 8 32Z" fill={n} />
        <path d="M32 38 56 26 32 14 8 26Z" fill={b} opacity={0.9} />
        <path d="M32 32 56 20 32 8 8 20Z" fill="#cfe6fb" />
        <path d="M20 20l6 3 8-4 8 4" stroke="#8fc1f2" strokeWidth={2} fill="none" />
        <path d="M34 2c5 0 8 3.5 8 7.5C42 15 34 22 34 22s-8-7-8-12.5C26 5.5 29 2 34 2Z" fill={o} />
        <circle cx={34} cy={9.5} r={3} fill="#fff" />
        <path d="M32 50 56 38V44L32 56 8 44V38Z" fill="#1d3b6e" opacity={0.25} />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      {defs}
      {art[kind]}
    </svg>
  );
}

function IsoSlab({ y, glow }: { y: number; glow: string }) {
  const c = 180;
  const w = 86;
  const d = 50;
  const h = 44;
  return (
    <g>
      <path d={`M${c - w} ${y}L${c} ${y + d}V${y + d + h}L${c - w} ${y + h}Z`} fill="#3f7fe0" />
      <path d={`M${c} ${y + d}L${c + w} ${y}V${y + h}L${c} ${y + d + h}Z`} fill="#2754b0" />
      <path d={`M${c} ${y - d}L${c + w} ${y}L${c} ${y + d}L${c - w} ${y}Z`} fill="#eaf5ff" />
      <path
        d={`M${c - w + 12} ${y + 22}L${c - 8} ${y + d + 22 - 12 * (d / w)}`}
        stroke={glow}
        strokeWidth={5}
        strokeLinecap="round"
      />
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={c + 20 + i * 18}
          cy={y + d + 20 - (20 + i * 18) * (d / w)}
          r={3}
          fill={i === 0 ? "#7ee0a4" : "#8fc1f2"}
          className={i === 0 ? "landing-blink" : undefined}
          style={{ animationDelay: `${y / 100}s` }}
        />
      ))}
    </g>
  );
}

function IsoCube({
  x,
  y,
  s,
  top,
  left,
  right,
}: Record<"x" | "y" | "s", number> & Record<"top" | "left" | "right", string>) {
  const d = s * 0.58;
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d={`M${-s} 0L0 ${d}V${d + s}L${-s} ${s}Z`} fill={left} />
      <path d={`M0 ${d}L${s} 0V${s}L0 ${d + s}Z`} fill={right} />
      <path d={`M0 ${-d}L${s} 0L0 ${d}L${-s} 0Z`} fill={top} />
    </g>
  );
}

/** Centre of the product grid: an isometric edge node under a small globe. */
export function EdgeNodeArt({ className }: { className?: string }) {
  const id = useIds("halo", "beam", "globe", "o");
  return (
    <svg viewBox="0 0 360 540" className={className} aria-hidden="true" overflow="visible">
      <defs>
        <radialGradient id={id.halo}>
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="0.7" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id.beam} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ffb14a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffb14a" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={id.globe} cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" stopColor="#6fa8ef" />
          <stop offset="1" stopColor="#1f3f86" />
        </radialGradient>
        <linearGradient id={id.o} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb14a" />
          <stop offset="1" stopColor="#ff5f45" />
        </linearGradient>
      </defs>
      <circle cx={180} cy={300} r={190} fill={`url(#${id.halo})`} />
      <ellipse cx={180} cy={470} rx={120} ry={26} fill="#183d6d" opacity={0.12} />
      <IsoSlab y={386} glow={`url(#${id.o})`} />
      <IsoSlab y={326} glow={`url(#${id.o})`} />
      <IsoSlab y={266} glow={`url(#${id.o})`} />
      <path d="M130 230 180 256 230 230 214 110H146Z" fill={`url(#${id.beam})`} />
      <g className="landing-float-slow">
        <circle cx={180} cy={128} r={56} fill={`url(#${id.globe})`} />
        <path
          d="M142 112c12-6 20 2 30-2s14-14 26-8 8 20-4 24-8 16-22 12-10-14-20-12-22-8-10-14Z"
          fill="#8fc1f2"
          opacity={0.75}
        />
        <ellipse
          cx={180}
          cy={128}
          rx={86}
          ry={20}
          fill="none"
          stroke="#ff9d42"
          strokeWidth={3}
          strokeDasharray="2 8"
          strokeLinecap="round"
          transform="rotate(-14 180 128)"
        />
        <Pin x={160} y={98} size={26} fill={`url(#${id.o})`} />
        <Pin x={206} y={120} size={22} fill={`url(#${id.o})`} delay={0.8} />
      </g>
      <g className="landing-float">
        <IsoCube x={52} y={240} s={16} top="#ffd9a8" left="#ff9d42" right="#ff6a3d" />
      </g>
      <g className="landing-float-slow">
        <IsoCube x={316} y={290} s={13} top="#eaf5ff" left="#5b95ea" right="#2c5cc0" />
      </g>
      <g className="landing-float">
        <IsoCube x={40} y={420} s={11} top="#eaf5ff" left="#5b95ea" right="#2c5cc0" />
      </g>
      <g className="landing-float-slow">
        <IsoCube x={322} y={440} s={15} top="#ffd9a8" left="#ff9d42" right="#ff6a3d" />
      </g>
    </svg>
  );
}

/** A satellite with solar wings (the "every corner of the globe" band). */
export function SatelliteArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 170" className={className} aria-hidden="true" overflow="visible">
      <g className="landing-float" transform="rotate(-24 100 85)">
        {[-1, 1].map((side) => (
          <g key={side} transform={`translate(${100 + side * 62} 85)`}>
            <rect x={-38} y={-18} width={76} height={36} rx={4} fill="#2c5cc0" />
            {[-19, 0, 19].map((x) => (
              <path key={x} d={`M${x} -18V18`} stroke="#8fc1f2" strokeOpacity={0.6} />
            ))}
            <path d="M-38 0H38" stroke="#8fc1f2" strokeOpacity={0.6} />
          </g>
        ))}
        <rect x={62} y={81} width={76} height={8} fill="#8fb0d8" />
        <rect x={78} y={56} width={44} height={58} rx={8} fill="#1d3b6e" />
        <rect x={84} y={62} width={32} height={46} rx={5} fill="#ff9d42" />
        <path d="M84 76H116M84 92H116" stroke="#ff6a3d" strokeWidth={2} />
        <path d="M100 56V36" stroke="#8fb0d8" strokeWidth={4} />
        <path d="M82 36a18 10 0 0 0 36 0Z" fill="#eaf5ff" />
        <circle cx={100} cy={30} r={4} fill="#ff6a3d" className="landing-blink" />
      </g>
    </svg>
  );
}

/** Floating dashboard panels and a chat bubble (the support card). */
export function SupportArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 420 380" className={className} aria-hidden="true" overflow="visible">
      <g className="landing-float-slow">
        <g transform="translate(40 60) rotate(-8)">
          <rect width={200} height={140} rx={14} fill="#2c4f8c" />
          <rect
            x={14}
            y={14}
            width={60}
            height={60}
            rx={30}
            fill="none"
            stroke="#8fc1f2"
            strokeWidth={10}
          />
          <path d="M44 14a30 30 0 0 1 30 30" stroke="#ff9d42" strokeWidth={10} fill="none" />
          {[16, 40, 64].map((y) => (
            <rect key={y} x={92} y={y} width={92} height={12} rx={6} fill="#8fc1f2" opacity={0.5} />
          ))}
          <rect x={14} y={96} width={170} height={28} rx={8} fill="#1d3b6e" />
          <rect x={24} y={106} width={80} height={8} rx={4} fill="#ff9d42" />
        </g>
      </g>
      <g className="landing-float">
        <g transform="translate(190 150) rotate(6)">
          <rect width={200} height={150} rx={16} fill="#eaf5ff" />
          <rect width={200} height={30} rx={14} fill="#bcd9f4" />
          <rect y={16} width={200} height={14} fill="#bcd9f4" />
          <circle cx={18} cy={15} r={4} fill="#ff6a3d" />
          <circle cx={32} cy={15} r={4} fill="#ffb14a" />
          <circle cx={46} cy={15} r={4} fill="#5b95ea" />
          <path
            d="M16 124 50 96 80 108 118 70 150 84 184 50"
            stroke="#ff7a3d"
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d="M16 124 50 96 80 108 118 70 150 84 184 50V136H16Z"
            fill="#ff9d42"
            opacity={0.15}
          />
        </g>
      </g>
      <g className="landing-float" style={{ animationDelay: "-2s" }}>
        <g transform="translate(270 40)">
          <path
            d="M0 16C0 7 7 0 16 0H104C113 0 120 7 120 16V56C120 65 113 72 104 72H40L18 90 22 72H16C7 72 0 65 0 56Z"
            fill="#fff"
          />
          {[36, 60, 84].map((x, i) => (
            <circle
              key={x}
              cx={x}
              cy={36}
              r={7}
              fill="#ff8a3d"
              className="landing-blink"
              style={{ animationDelay: `${i * 0.3}s` }}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}

const GLOBE: Projection = { cx: 560, cy: 650, r: 540, lat0: -38, lon0: 108 };

/**
 * A dome of the globe centred on Asia-Pacific, with a pin for every region
 * placed from its code or name (lib/places).
 */
export function WorldGlobe({
  regions,
  className,
}: {
  regions: { name: string; code: string }[];
  className?: string;
}) {
  const id = useIds("sea", "land", "fade", "air", "clip", "o");
  const p = GLOBE;
  const paths = React.useMemo(() => landPaths(GLOBE), []);
  const pins = regions.slice(0, 40).map((region) => {
    const [lat, lon] = placeOf(region) ?? fallbackPlace(hashUnit(region.code));
    // Spread regions that land on the same city a little.
    const jitter = (hashUnit(`${region.code}:j`) - 0.5) * 2.4;
    return { region, ...project(p, lat + jitter, lon + jitter) };
  });
  return (
    <svg viewBox="0 0 1120 560" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={id.sea} cx="0.5" cy="0.08" r="0.95">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#f1f8ff" />
          <stop offset="0.8" stopColor="#d6ebfc" />
          <stop offset="1" stopColor="#b9dbf7" />
        </radialGradient>
        <linearGradient id={id.land} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6aa6df" />
          <stop offset="1" stopColor="#8cbde9" />
        </linearGradient>
        <linearGradient id={id.fade} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#e1f2ff" stopOpacity="0" />
          <stop offset="1" stopColor="#e1f2ff" />
        </linearGradient>
        <radialGradient id={id.air}>
          <stop offset="0.9" stopColor="#bfe0ff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#bfe0ff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={id.clip}>
          <circle cx={p.cx} cy={p.cy} r={p.r} />
        </clipPath>
        <linearGradient id={id.o} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb14a" />
          <stop offset="1" stopColor="#ff5f45" />
        </linearGradient>
      </defs>
      <circle cx={p.cx} cy={p.cy} r={p.r + 22} fill={`url(#${id.air})`} />
      <circle cx={p.cx} cy={p.cy} r={p.r} fill={`url(#${id.sea})`} />
      <g clipPath={`url(#${id.clip})`}>
        {paths.map((d) => (
          <path
            key={d.slice(0, 24)}
            d={d}
            fill={`url(#${id.land})`}
            stroke="#ffffff"
            strokeOpacity={0.7}
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
        ))}
      </g>
      {pins
        .filter((pin) => pin.visible && pin.y < 540)
        .map((pin, i) => (
          <Pin
            key={pin.region.code}
            x={pin.x}
            y={pin.y}
            size={30}
            fill={`url(#${id.o})`}
            delay={i * 0.35}
            title={pin.region.name}
          />
        ))}
      <rect x={0} y={0} width={1120} height={560} fill={`url(#${id.fade})`} />
    </svg>
  );
}
