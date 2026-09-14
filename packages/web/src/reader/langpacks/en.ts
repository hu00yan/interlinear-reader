// TrackB 真包直连（单源对齐）：复用 packages/lang-packs 的 segment/lemmatize，
// 本文件仅做形状适配（LanguagePack），规则只在 TrackB 一处维护。
// fallback.ts 保留为离线兜底（langpack-loader 加载失败时）。
// 注：ja 不在此列——TrackB ja builtin 无 lexicon/wasm 时 kanji run 不拆词，
// 不如 fallback 的 Intl.Segmenter；等 wasm 接入后再直连。
import type { LanguagePack } from '../../types.js';
// @ts-expect-error — TrackB .mjs 暂无类型声明（有类型之日此行报错，届时删掉即可）
import * as pack from '../../../../lang-packs/src/en.mjs';

export const packEn: LanguagePack = {
  code: 'en',
  segment: (text: string): string[] => pack.segment(text),
  lemmatize: (token: string): string => pack.lemmatize(token),
};
export default packEn;
