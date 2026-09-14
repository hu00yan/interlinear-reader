// 缓存键：sha1(lang|target|lemma|归一化句) —— 契约锁死。
// 归一化：NFKC + 小写（ja 外）+ 去首尾空白 + 连续空白折叠。

export function normalizeSentence(s: string, lang: string): string {
  let t = s.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (lang !== 'ja') t = t.toLowerCase();
  return t;
}

/** hex sha1：优先 SubtleCrypto，file:// 等不可用时回退内嵌同步纯 JS SHA1（同值，仍 40 小写 hex） */
export async function sha1Hex(text: string): Promise<string> {
  try {
    if (crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  return sha1Sync(text);
}

/** 同步纯 JS SHA1（RFC 3174，无依赖；与 SubtleCrypto 同值，用于 file:// 回退） */
export function sha1Sync(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLenHi = Math.floor((data.length * 8) / 0x100000000);
  const bitLenLo = (data.length * 8) >>> 0;
  const paddedLen = (((data.length + 9 + 63) >> 6) << 6);
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[data.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi);
  dv.setUint32(paddedLen - 4, bitLenLo);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 词级缓存键：sha1(lang|target|lemma|)（句部分为空）。
 * 同步纯 JS SHA1（与 SubtleCrypto 同值，见上）：逐词查词是热路径，
 * 省掉每词一次 subtle.digest 的异步调度。签名保持 async（调用方与契约不变）。 */
export async function wordCacheKey(lang: string, target: string, lemma: string): Promise<string> {
  return sha1Sync(`${lang}|${target}|${normalizeSentence(lemma, lang)}|`);
}

/** 句级缓存键：sha1(lang|target||归一化句)（lemma 部分为空；同上，同步计算） */
export async function sentenceCacheKey(lang: string, target: string, sentence: string): Promise<string> {
  return sha1Sync(`${lang}|${target}||${normalizeSentence(sentence, lang)}`);
}
