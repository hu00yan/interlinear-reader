// TrackB 真包直连（单源对齐）：见 en.ts 头注。
import type { LanguagePack } from '../../types.js';
// @ts-expect-error — TrackB .mjs 暂无类型声明（有类型之日此行报错，届时删掉即可）
import * as pack from '../../../../lang-packs/src/es.mjs';

export const packEs: LanguagePack = {
  code: 'es',
  segment: (text: string): string[] => pack.segment(text),
  lemmatize: (token: string): string => pack.lemmatize(token),
};
export default packEs;
