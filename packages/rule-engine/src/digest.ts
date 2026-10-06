// MD5 (RFC 1321), SHA-1 and SHA-256 (FIPS 180-4) over byte strings (one character per byte),
// as lowercase hex. The reference evaluator runs in browsers too, where node:crypto is
// unavailable and Web Crypto is asynchronous and has no MD5.

const hex = (words: number[], littleEndian: boolean) =>
  words
    .map((w) => {
      const bytes = [w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff];
      return (littleEndian ? bytes.reverse() : bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    })
    .join("");

/** The message padded to 64-byte blocks with its bit length (big- or little-endian) at the end. */
function pad(message: string, littleEndian: boolean): DataView {
  const length = message.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  for (let i = 0; i < length; i++) padded[i] = message.charCodeAt(i);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  const high = Math.floor(bits / 0x100000000);
  const low = bits >>> 0;
  if (littleEndian) {
    view.setUint32(padded.length - 8, low, true);
    view.setUint32(padded.length - 4, high, true);
  } else {
    view.setUint32(padded.length - 8, high);
    view.setUint32(padded.length - 4, low);
  }
  return view;
}

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

export function md5Hex(message: string): string {
  const view = pad(message, true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Array<number>(16);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + (MD5_K[i] as number) + (m[g] as number)) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, MD5_SHIFTS[i] as number)) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  return hex([a0, b0, c0, d0], true);
}

export function sha1Hex(message: string): string {
  const view = pad(message, false);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Array<number>(80);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(offset + j * 4);
    for (let j = 16; j < 80; j++)
      w[j] = rotl(
        (w[j - 3] as number) ^ (w[j - 8] as number) ^ (w[j - 14] as number) ^ (w[j - 16] as number),
        1,
      );
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let j = 0; j < 80; j++) {
      const [f, k] =
        j < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : j < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : j < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + (w[j] as number)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    for (const [i, v] of [a, b, c, d, e].entries()) h[i] = ((h[i] as number) + v) | 0;
  }
  return hex(h, false);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256Hex(message: string): string {
  const view = pad(message, false);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(offset + j * 4);
    for (let j = 16; j < 64; j++) {
      const x = w[j - 15] as number;
      const y = w[j - 2] as number;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[j] = ((w[j - 16] as number) + s0 + (w[j - 7] as number) + s1) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let j = 0; j < 64; j++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + s1 + ch + (SHA256_K[j] as number) + (w[j] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    for (const [i, v] of [a, b, c, d, e, f, g, k].entries()) h[i] = ((h[i] as number) + v) | 0;
  }
  return hex(h, false);
}
