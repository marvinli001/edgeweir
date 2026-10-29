import * as React from "react";

function remaining(target: string) {
  return Math.max(0, Math.floor((new Date(target).getTime() - Date.now()) / 1000));
}

/** A countdown to a deadline as H:MM:SS (hours only when needed), in tabular figures. */
export function Countdown({ target, className }: { target: string; className?: string }) {
  const [left, setLeft] = React.useState(() => remaining(target));
  React.useEffect(() => {
    setLeft(remaining(target));
    const timer = setInterval(() => setLeft(remaining(target)), 1000);
    return () => clearInterval(timer);
  }, [target]);
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <time className={className} dateTime={target}>
      <span className="font-mono tabular-nums">
        {hours > 0 ? `${hours}:` : ""}
        {pad(minutes)}:{pad(seconds)}
      </span>
    </time>
  );
}
