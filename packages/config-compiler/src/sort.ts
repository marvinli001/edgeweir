/** Sorted, de-duplicated copy: list order carries no meaning in these fields. */
export const sortedSet = <T extends string | number>(values: readonly T[] | undefined): T[] =>
  [...new Set(values ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export const byString =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

/** Byte order of the UTF-8 encoding, as Go compares strings (unlike UTF-16 beyond U+FFFF). */
export const byBytes =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    Buffer.compare(Buffer.from(key(a), "utf8"), Buffer.from(key(b), "utf8"));

/** Sorted (UTF-8 byte order), de-duplicated copy of a set of strings. */
export const sortedByteSet = (values: readonly string[] | undefined): string[] =>
  [...new Set(values ?? [])].sort(byBytes((value) => value));
