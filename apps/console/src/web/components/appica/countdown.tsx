import { Countdown as AppicaCountdown, CountdownSegment } from "@appica/ui-react/countdown";
import { AppicaScope } from "@/components/appica/scope";

/** Rolling-digit countdown to a deadline, as H:MM:SS (hours only when needed). */
export function Countdown({ target, className }: { target: string; className?: string }) {
  return (
    <AppicaScope>
      <AppicaCountdown targetDate={target} className={className}>
        {({ hours, days }) => (
          <span className="inline-flex items-center font-mono tabular-nums">
            {days * 24 + hours > 0 ? (
              <>
                <CountdownSegment value={days * 24 + hours} minDigits={1} />:
              </>
            ) : null}
            <CountdownSegment unit="minutes" />:
            <CountdownSegment unit="seconds" />
          </span>
        )}
      </AppicaCountdown>
    </AppicaScope>
  );
}
