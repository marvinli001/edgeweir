import { OTPField as AppicaOTPField, OTPFieldInput } from "@appica/ui-react/otp-field";
import { AppicaScope } from "@/components/appica/scope";

/**
 * One-time code input (TOTP), one slot per digit; each slot is a sunk field like the console's
 * inputs (appica's soft variant over the well, input-well's inner shadow and hairline).
 */
export function OtpField({
  length = 6,
  value,
  onValueChange,
  onComplete,
  label,
  invalid,
  autoFocus,
}: {
  length?: number;
  value: string;
  onValueChange: (value: string) => void;
  /** Called once every slot is filled. */
  onComplete?: (value: string) => void;
  label: string;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <AppicaScope className="[--background-muted:var(--well)]">
      <AppicaOTPField
        variant="soft"
        length={length}
        value={value}
        onValueChange={onValueChange}
        onValueComplete={onComplete}
        validationType="numeric"
        autoComplete="one-time-code"
        aria-label={label}
        data-testid="otp-field"
      >
        {Array.from({ length }, (_, index) => (
          <OTPFieldInput
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional
            key={index}
            className="rounded-xl input-well"
            aria-invalid={invalid || undefined}
            autoFocus={autoFocus && index === 0}
          />
        ))}
      </AppicaOTPField>
    </AppicaScope>
  );
}
