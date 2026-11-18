import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";

export function SearchField(props: ComponentProps<"input">) {
  return (
    <InputGroup className="has-[:focus-visible]:ring-0! pointer-coarse:min-h-11">
      <InputGroupAddon>
        <HugeiconsIcon icon={Search01Icon} strokeWidth={1.75} aria-hidden />
      </InputGroupAddon>
      <InputGroupInput type="search" className="focus-visible:shadow-none!" {...props} />
    </InputGroup>
  );
}
