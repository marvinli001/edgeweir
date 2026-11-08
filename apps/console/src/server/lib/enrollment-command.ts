/** Shell-quotes a value for the generated install command. */
function sh(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The shell reads the command from stdin; sudo only sees private file paths. */
export function buildInstallCommand(opts: {
  consoleUrl: string;
  serverUrl: string;
  token: string;
  caSha256: string;
}): string {
  const script = `${opts.consoleUrl.replace(/\/$/, "")}/install.sh`;
  return [
    "sh <<'EDGEWEIR_INSTALL'",
    "set -eu",
    "unset EDGEWEIR_TOKEN",
    "umask 077",
    "d=",
    `trap '[ -z "$d" ] || rm -rf "$d"' EXIT`,
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    'd=$(mktemp -d "${TMPDIR:-/tmp}/edgeweir-install.XXXXXXXX")',
    'chmod 0700 "$d"',
    `cat >"$d/token" <<'EDGEWEIR_ENROLLMENT_TOKEN'`,
    opts.token,
    "EDGEWEIR_ENROLLMENT_TOKEN",
    'chmod 0600 "$d/token"',
    `curl -fsSL ${sh(script)} -o "$d/install.sh"`,
    `set -- --token-file "$d/token" --server ${sh(opts.serverUrl)} --ca-sha256 ${sh(opts.caSha256)}`,
    'if [ "$(id -u)" = 0 ]; then',
    '  bash "$d/install.sh" "$@" </dev/null',
    "else",
    '  sudo bash "$d/install.sh" "$@" </dev/null',
    "fi",
    "EDGEWEIR_INSTALL",
  ].join("\n");
}
