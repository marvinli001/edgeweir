import { validHostHeader } from "@edgeweir/rule-engine";
import { fail } from "./errors";

/**
 * Refuses the Host header of an origin or origin rule that nodes would refuse: they skip such an
 * origin (the site goes offline when it was the only one) and drop such a rule. Empty is unset.
 */
export function assertHostHeader(hostHeader: string): void {
  if (hostHeader !== "" && !validHostHeader(hostHeader))
    fail(
      "ORIGIN_HOST_HEADER_INVALID",
      `invalid Host header ${JSON.stringify(hostHeader)}: use a host name or IP address with an optional port, IPv6 in brackets when it has a port`,
      { hostHeader },
    );
}
