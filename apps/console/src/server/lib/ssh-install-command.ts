import type { SshInstallOptions } from "@edgeweir/contract";

export const sh = (value: string) =>
  /^[A-Za-z0-9_./:@=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
export const inputMarker = (id: string) => `EDGEWEIR_INPUT_READY_${id}`;

// stty must succeed before the client sends any secret, even when the server ignores PTY modes.
const INPUT = `if [ -t 0 ]; then stty raw -echo || exit 94; printf '\\n%s\\n' "$ready"; fi`;
const SUDO = `if [ "$(id -u)" = 0 ]; then "$@" </dev/null
elif [ "$mode" = sudo-s ]; then printf '%s\\n' "$p" | sudo -S -k -p '' -- "$@"
else sudo -n -- "$@" </dev/null; fi`;

const WATCHDOG = `d=$1; stage=$2; pid=$3; start=$4; deadline=$5
same() { [ "$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null)" = "$start" ]; }
while same && [ ! -e "$d/cancel" ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.2; done
state=stopped
if same && [ ! -e "$d/cancel" ] && [ "$(date +%s)" -ge "$deadline" ]; then : >"$d/timed_out"; fi
if [ -e "/proc/$pid/stat" ] && ! same; then state=unknown
else
  kill -TERM -- "-$pid" 2>/dev/null || true
  for ((i=0;i<25;i++)); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.2; done
  kill -KILL -- "-$pid" 2>/dev/null || true
  for ((i=0;i<10;i++)); do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.2; done
  # Zombies cannot execute or retain open files; their parent will reap them.
  if ps -eo pgid=,stat= | awk -v p="$pid" '$1==p && $2 !~ /^Z/ {found=1} END {exit !found}'; then state=unknown; fi
fi
rm -rf -- "$stage" "$d/tmp"
printf '%s\\n' "$state" >"$d/status"
sleep 15
rm -rf -- "$d"`;

const WORKER = `d=$1; stage=$2; url=$3; shift 3
TMPDIR=$d/tmp; export TMPDIR
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 143' TERM
while [ ! -e "$d/go" ]; do sleep 0.1; done
printf 'EDGEWEIR_PHASE downloading\\n'
curl -fsSL --connect-timeout 15 --max-time 120 -o "$stage/install.sh" "$url" || exit 91
printf 'EDGEWEIR_PHASE installing\\n'
bash "$stage/install.sh" --token-file "$stage/token" "$@" </dev/null`;

const ROOT_RUNNER = `exec </dev/null
d=$1; stage=$2; seconds=$3; url=$4; shift 4
for tool in setsid timeout bash curl; do command -v "$tool" >/dev/null || exit 95; done
umask 077
mkdir -m 700 -- "$d" || exit 92
mkdir -m 700 -- "$d/tmp" || exit 92
nohup setsid timeout --signal=TERM --kill-after=5s "$seconds" bash -c ${sh(WORKER)} edgeweir-worker "$d" "$stage" "$url" "$@" >"$d/output" 2>&1 &
pid=$!
start=$(awk '{print $22}' "/proc/$pid/stat") || exit 92
printf '%s %s\\n' "$pid" "$start" >"$d/process"
deadline=$(( $(date +%s) + seconds ))
nohup setsid bash -c ${sh(WATCHDOG)} edgeweir-watchdog "$d" "$stage" "$pid" "$start" "$deadline" >/dev/null 2>&1 &
printf 'EDGEWEIR_TASK_STARTED\\n'
: >"$d/go"
tail --pid="$pid" -n +1 -f "$d/output" & reader=$!
wait "$pid"; code=$?
wait "$reader" 2>/dev/null || true
for ((i=0;i<45;i++)); do [ ! -e "$d/status" ] || break; sleep 0.2; done
state=$(cat "$d/status" 2>/dev/null) || state=unknown
if [ -e "$d/timed_out" ]; then code=124; fi
printf '\\nEDGEWEIR_CLEANUP %s\\n' "$state"
if [ "$state" = stopped ]; then rm -rf -- "$d"; fi
exit "$code"`;

/** stdin is always exactly token + sudo password (possibly empty). No secret enters argv or env. */
export const REMOTE_SCRIPT = `LC_ALL=C; export LC_ALL
url=$0; mode=$1; id=$2; seconds=$3; ready=$4; shift 4
${INPUT}
IFS= read -r t || exit 90
IFS= read -r p || p=
stage=/tmp/edgeweir-ssh-$id; d=/tmp/edgeweir-ssh-root-$id
umask 077
mkdir -m 700 -- "$stage" || exit 92
trap 'rm -rf -- "$stage"' EXIT
printf '%s\\n' "$t" >"$stage/token" || exit 92
t=
set -- bash -c ${sh(ROOT_RUNNER)} edgeweir-runner "$d" "$stage" "$seconds" "$url" "$@"
${SUDO}`;

export function buildPreflightCommand(id: string, mode: "sudo-s" | "sudo-n"): string {
  const script = `LC_ALL=C; export LC_ALL
mode=$1; ready=$2\n${INPUT}\nIFS= read -r p || p=\nset -- true\n${SUDO}`;
  return ["sh", "-c", script, "edgeweir-preflight", mode, inputMarker(id)].map(sh).join(" ");
}

const CLEANUP = `exec </dev/null
d=$1
if [ ! -d "$d" ] || [ -L "$d" ] || [ ! -f "$d/process" ] || [ "$(stat -c %u "$d")" != 0 ]; then printf 'EDGEWEIR_CLEANUP unknown\\n'; exit 1; fi
: >"$d/cancel"
for ((i=0;i<45;i++)); do [ ! -e "$d/status" ] || break; sleep 0.2; done
state=$(cat "$d/status" 2>/dev/null) || state=unknown
if [ -f "$d/output" ]; then
  if [ "$(stat -c %s "$d/output")" -gt 16384 ]; then tail -c 16384 "$d/output" | sed '1d'; else cat "$d/output"; fi
fi
printf '\\nEDGEWEIR_CLEANUP %s\\n' "$state"
if [ "$state" = stopped ]; then rm -rf -- "$d"; else exit 1; fi`;

export function buildCleanupCommand(id: string, mode: "sudo-s" | "sudo-n"): string {
  const script = `LC_ALL=C; export LC_ALL
mode=$1; ready=$2; d=$3\n${INPUT}\nIFS= read -r p || p=\nset -- bash -c ${sh(CLEANUP)} edgeweir-cleanup "$d"\n${SUDO}`;
  return [
    "sh",
    "-c",
    script,
    "edgeweir-cleanup",
    mode,
    inputMarker(id),
    `/tmp/edgeweir-ssh-root-${id}`,
  ]
    .map(sh)
    .join(" ");
}

export function buildRemoteCommand(opts: {
  consoleUrl: string;
  serverUrl: string;
  caSha256: string;
  options: SshInstallOptions;
  sudo: "sudo-s" | "sudo-n";
  taskId?: string;
  timeoutSeconds?: number;
}): string {
  const { options } = opts;
  const args = ["--server", opts.serverUrl, "--ca-sha256", opts.caSha256];
  if (options.version) args.push("--version", options.version);
  if (options.format !== "auto") args.push("--format", options.format);
  if (options.mirror) args.push("--mirror", options.mirror);
  if (options.mirrorOnly) args.push("--mirror-only");
  if (!options.modsecurity) args.push("--no-modsecurity");
  if (options.noStart) args.push("--no-start");
  const id = opts.taskId ?? crypto.randomUUID();
  const url = `${opts.consoleUrl.replace(/\/$/, "")}/install.sh`;
  return [
    "sh",
    "-c",
    REMOTE_SCRIPT,
    url,
    opts.sudo,
    id,
    String(Math.max(1, Math.ceil(opts.timeoutSeconds ?? 900))),
    inputMarker(id),
    ...args,
  ]
    .map(sh)
    .join(" ");
}
