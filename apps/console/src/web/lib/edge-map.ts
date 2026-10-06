/**
 * Where edge locations are on a map. Regions carry no coordinates, so a region is placed by the
 * city its code or name mentions (ap-tokyo, Tokyo, 东京); unknown ones are left off the map.
 */
export type LatLng = [number, number];

const PLACES: [RegExp, LatLng][] = [
  [/tokyo|东京|nrt|hnd/i, [35.68, 139.69]],
  [/osaka|大阪|kix/i, [34.69, 135.5]],
  [/seoul|首尔|icn/i, [37.57, 126.98]],
  [/singapore|新加坡|sin\b/i, [1.35, 103.82]],
  [/hong.?kong|香港|hkg/i, [22.32, 114.17]],
  [/taipei|台北|tpe/i, [25.03, 121.57]],
  [/shanghai|上海|sha\b|pvg/i, [31.23, 121.47]],
  [/beijing|北京|pek|pkx/i, [39.9, 116.4]],
  [/guangzhou|广州|can\b/i, [23.13, 113.26]],
  [/shenzhen|深圳|szx/i, [22.54, 114.06]],
  [/mumbai|孟买|bom/i, [19.08, 72.88]],
  [/sydney|悉尼|syd/i, [-33.87, 151.21]],
  [/frankfurt|法兰克福|fra\b/i, [50.11, 8.68]],
  [/amsterdam|阿姆斯特丹|ams/i, [52.37, 4.9]],
  [/london|伦敦|lhr|lon\b/i, [51.51, -0.13]],
  [/paris|巴黎|cdg/i, [48.86, 2.35]],
  [/virginia|弗吉尼亚|ashburn|iad/i, [38.95, -77.45]],
  [/new.?york|纽约|nyc|jfk/i, [40.71, -74.01]],
  [/chicago|芝加哥|ord/i, [41.88, -87.63]],
  [/dallas|达拉斯|dfw/i, [32.78, -96.8]],
  [/los.?angeles|洛杉矶|lax/i, [34.05, -118.24]],
  [/san.?jose|silicon|圣何塞|sjc/i, [37.34, -121.89]],
  [/seattle|西雅图|sea\b/i, [47.61, -122.33]],
  [/toronto|多伦多|yyz/i, [43.65, -79.38]],
  [/s[aã]o.?paulo|圣保罗|gru/i, [-23.55, -46.63]],
];

/** The coordinates of the first known city in the texts (a region's code, then its name). */
export function placeOf(...texts: (string | null | undefined)[]): LatLng | null {
  for (const text of texts) {
    if (!text) continue;
    for (const [pattern, location] of PLACES) if (pattern.test(text)) return location;
  }
  return null;
}
