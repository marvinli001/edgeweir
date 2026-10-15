/**
 * Copying that also works outside secure contexts: the console is often opened over plain HTTP on
 * a LAN address (compose listens on 0.0.0.0:3000), where `navigator.clipboard` does not exist.
 */

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

/** Saves `text` as a file named `name` (a PEM certificate, a zone file). */
export function downloadText(name: string, text: string, type = "application/x-pem-file") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
