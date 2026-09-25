/**
 * Where a region most likely is, from its code or its (often Chinese) name,
 * so landing pages can pin it on a map. Matching is by substring, first hit
 * wins; regions that match nothing get a stable spot from `fallbackPlace`.
 */
const PLACES: [string[], [number, number]][] = [
  [
    ["cn-east", "east-china", "shanghai", "sha", "华东", "上海", "杭州", "江苏", "浙江"],
    [31.2, 121.5],
  ],
  [
    ["cn-north", "north-china", "beijing", "pek", "华北", "北京", "天津"],
    [39.9, 116.4],
  ],
  [
    ["cn-south", "south-china", "guangzhou", "shenzhen", "can", "华南", "广州", "深圳", "广东"],
    [23.1, 113.3],
  ],
  [
    ["cn-west", "cn-southwest", "chengdu", "chongqing", "西南", "华西", "成都", "重庆"],
    [30.6, 104.1],
  ],
  [
    ["cn-central", "wuhan", "华中", "武汉"],
    [30.6, 114.3],
  ],
  [
    ["cn-northeast", "shenyang", "东北", "沈阳"],
    [41.8, 123.4],
  ],
  [
    ["cn-northwest", "xian", "西北", "西安"],
    [34.3, 108.9],
  ],
  [
    ["hk", "hongkong", "hong-kong", "香港"],
    [22.3, 114.2],
  ],
  [
    ["macau", "macao", "澳门"],
    [22.2, 113.5],
  ],
  [
    ["tw", "taipei", "taiwan", "台湾", "台北"],
    [25, 121.5],
  ],
  [
    ["sg", "sin", "singapore", "新加坡"],
    [1.35, 103.8],
  ],
  [
    ["osaka", "kix", "大阪"],
    [34.7, 135.5],
  ],
  [
    ["jp", "tokyo", "nrt", "hnd", "japan", "日本", "东京"],
    [35.7, 139.7],
  ],
  [
    ["kr", "seoul", "icn", "korea", "韩国", "首尔"],
    [37.6, 127],
  ],
  [
    ["id", "jakarta", "cgk", "indonesia", "印尼", "印度尼西亚", "雅加达"],
    [-6.2, 106.8],
  ],
  [
    ["mumbai", "bom", "孟买"],
    [19.1, 72.9],
  ],
  [
    ["in", "india", "delhi", "del", "印度", "德里"],
    [28.6, 77.2],
  ],
  [
    ["th", "bangkok", "bkk", "泰国", "曼谷"],
    [13.8, 100.5],
  ],
  [
    ["vn", "vietnam", "hanoi", "sgn", "越南", "胡志明", "河内"],
    [10.8, 106.7],
  ],
  [
    ["my", "kul", "malaysia", "kuala", "马来西亚", "吉隆坡"],
    [3.1, 101.7],
  ],
  [
    ["ph", "manila", "mnl", "philippines", "菲律宾", "马尼拉"],
    [14.6, 121],
  ],
  [
    ["syd", "sydney", "au", "australia", "澳大利亚", "澳洲", "悉尼"],
    [-33.9, 151.2],
  ],
  [
    ["mel", "melbourne", "墨尔本"],
    [-37.8, 145],
  ],
  [
    ["dxb", "dubai", "uae", "迪拜", "阿联酋"],
    [25.2, 55.3],
  ],
  [
    ["fra", "frankfurt", "de", "germany", "法兰克福", "德国"],
    [50.1, 8.7],
  ],
  [
    ["ams", "amsterdam", "nl", "阿姆斯特丹", "荷兰"],
    [52.4, 4.9],
  ],
  [
    ["lon", "lhr", "london", "uk", "gb", "伦敦", "英国"],
    [51.5, -0.1],
  ],
  [
    ["par", "cdg", "paris", "fr", "巴黎", "法国"],
    [48.9, 2.4],
  ],
  [
    ["ru", "moscow", "mow", "俄罗斯", "莫斯科"],
    [55.8, 37.6],
  ],
];

/** Cities used when a region matches nothing above (all on the Asia-Pacific side). */
const FALLBACK: [number, number][] = [
  [31.2, 121.5],
  [22.3, 114.2],
  [1.35, 103.8],
  [35.7, 139.7],
  [37.6, 127],
  [13.8, 100.5],
  [19.1, 72.9],
  [-6.2, 106.8],
  [14.6, 121],
  [30.6, 104.1],
  [39.9, 116.4],
  [-33.9, 151.2],
];

export function placeOf(region: { code: string; name: string }): [number, number] | null {
  const haystack = `${region.code} ${region.name}`.toLowerCase();
  const tokens = haystack.split(/[^a-z0-9一-鿿-]+/).filter(Boolean);
  for (const [aliases, coords] of PLACES) {
    for (const alias of aliases) {
      const ascii = /^[a-z0-9-]+$/.test(alias);
      // Short ASCII codes must match a whole token ("de" is not "cn-north-de...").
      if (
        ascii
          ? tokens.includes(alias) || (alias.length > 3 && haystack.includes(alias))
          : haystack.includes(alias)
      ) {
        return coords;
      }
    }
  }
  return null;
}

export function fallbackPlace(seed: number): [number, number] {
  return FALLBACK[Math.floor(seed * FALLBACK.length) % FALLBACK.length] ?? [31.2, 121.5];
}
