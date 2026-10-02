/**
 * Browser helpers that also work outside secure contexts. The console is often opened over plain
 * HTTP on a LAN address (compose listens on 0.0.0.0:3000), where `crypto.randomUUID` and
 * `navigator.clipboard` do not exist.
 */

/** An RFC 9562 version 4 UUID from `crypto.getRandomValues`. */
export function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Copies `text`: with the Clipboard API where it exists, else by selecting it in a hidden textarea
 * placed in `container` (inside an open dialog, so its focus trap keeps the selection) and
 * `execCommand("copy")`. Resolves whether it was copied.
 */
export async function copyText(text: string, container: HTMLElement = document.body) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission: try the selection below.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0" });
  container.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
