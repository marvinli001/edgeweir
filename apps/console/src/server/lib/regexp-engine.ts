import v8 from "node:v8";

/**
 * Site pattern domains (`~…`) are matched in the console with JavaScript
 * regular expressions (purge and prefetch resolution). V8's engine
 * backtracks; with this flag a regular expression that exceeds V8's
 * backtrack limit is run again by its linear engine, so no pattern blocks
 * the process. Set at import, before the patterns compile.
 */
v8.setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks");
