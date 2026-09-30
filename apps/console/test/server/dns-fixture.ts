export type FixtureRecord = { name: string; type: string; data: string; ttl: number };

/**
 * In-memory DNS provider accounts for the fake certd: one zone map per API
 * token. Tests replace `runCertd` with `fakeCertd` (vi.mock), so no helper
 * process runs.
 */
export const dnsFixture = {
  accounts: new Map<string, { zones: string[] }>(),
  zones: new Map<string, FixtureRecord[]>(),
  down: new Set<string>(),
  failAfterWrite: new Set<string>(),
  calls: [] as { command: string; token: string; zone?: string; records?: FixtureRecord[] }[],
  reset() {
    this.accounts.clear();
    this.zones.clear();
    this.down.clear();
    this.failAfterWrite.clear();
    this.calls = [];
  },
  records(token: string, zone: string) {
    return this.zones.get(`${token}/${zone.replace(/\.$/, "")}`) ?? [];
  },
  set(token: string, zone: string, records: FixtureRecord[]) {
    this.zones.set(`${token}/${zone.replace(/\.$/, "")}`, records);
  },
};

const same = (a: FixtureRecord, b: FixtureRecord) =>
  a.name === b.name && a.type === b.type && a.data === b.data;

type CertdErrorClass = new (command: string, code: string) => Error;

/**
 * The fake `runCertd`. The error class is the real CertdError, passed in by
 * the vi.mock factory (this module must not import the mocked module).
 */
export const makeFakeCertd = (CertdError: CertdErrorClass) =>
  async function fakeCertd(
    _app: unknown,
    command: string,
    input: {
      zone?: string;
      credentials: Record<string, string>;
      records?: FixtureRecord[];
      outbound?: { allowCidrs: string[] };
    },
  ) {
    const token = input.credentials.api_token ?? "";
    dnsFixture.calls.push({ command, token, zone: input.zone, records: input.records });
    if (!Array.isArray(input.outbound?.allowCidrs)) throw new Error("outbound policy missing");
    const account = dnsFixture.accounts.get(token);
    if (!account) throw new CertdError(command, "dns_auth_failed");
    if (dnsFixture.down.has(token)) throw new CertdError(command, "dns_provider_unreachable");
    if (command === "dns.zones") return [...account.zones];
    const zone = (input.zone ?? "").replace(/\.$/, "");
    if (!account.zones.includes(zone)) throw new CertdError(command, "dns_zone_not_found");
    let records = dnsFixture.records(token, zone).map((r) => ({ ...r }));
    const given = input.records ?? [];
    if (command === "dns.test") return { records: records.length };
    if (command === "dns.list") return records;
    if (command === "dns.set")
      records = [
        ...records.filter((r) => !given.some((g) => g.name === r.name && g.type === r.type)),
        ...given.map((r) => ({ ...r })),
      ];
    else if (command === "dns.present")
      records = [...records, ...given.filter((g) => !records.some((r) => same(r, g)))];
    else if (command === "dns.cleanup")
      records = records.filter((r) => !given.some((g) => same(r, g)));
    else throw new CertdError(command, "dns_invalid_request");
    dnsFixture.set(token, zone, records);
    if (dnsFixture.failAfterWrite.delete(token))
      throw new CertdError(command, "dns_provider_unreachable");
    return given.map((r) => ({ ...r }));
  };

/** Follows CNAMEs inside one zone's records and returns the sorted addresses of a name. */
export function resolve(records: FixtureRecord[], zone: string, fqdn: string, depth = 0): string[] {
  if (depth > 8) return [];
  const name = fqdn === zone ? "@" : fqdn.slice(0, -zone.length - 1);
  const cname = records.find((r) => r.name === name && r.type === "CNAME");
  if (cname) return resolve(records, zone, cname.data.replace(/\.$/, ""), depth + 1);
  return records
    .filter((r) => r.name === name && (r.type === "A" || r.type === "AAAA"))
    .map((r) => r.data)
    .sort();
}
