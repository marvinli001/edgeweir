import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { m } from "@/lib/i18n";

/** Search input that updates the URL a moment after typing stops. */
export function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = React.useState(value);
  const latest = React.useRef(onChange);
  latest.current = onChange;
  // The URL holds the trimmed text: a space typed between words is not taken back.
  React.useEffect(
    () => setText((current) => (current.trim() === value ? current : value)),
    [value],
  );
  React.useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => latest.current(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text, value]);
  return (
    <InputGroup className="w-full sm:w-72">
      <InputGroupAddon>
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={m.sites_search_placeholder()}
        aria-label={m.sites_search_placeholder()}
        data-testid="sites-search"
      />
    </InputGroup>
  );
}
