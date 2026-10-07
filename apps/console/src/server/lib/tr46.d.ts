// tr46 6.0.0 ships no types; its README documents these options (all
// default to false) and index.js returns null from toASCII on an error.
declare module "tr46" {
  export interface Options {
    checkBidi?: boolean;
    checkHyphens?: boolean;
    checkJoiners?: boolean;
    ignoreInvalidPunycode?: boolean;
    transitionalProcessing?: boolean;
    useSTD3ASCIIRules?: boolean;
    verifyDNSLength?: boolean;
  }
  export function toASCII(domainName: string, options?: Options): string | null;
  export function toUnicode(
    domainName: string,
    options?: Options,
  ): { domain: string; error: boolean };
}
