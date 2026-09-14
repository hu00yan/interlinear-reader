// LanguagePack 动态加载（契约锁死）：Track B 提供时动态 import，缺失则 fallback。
// 首屏不打包任何语言包，保证 `npm run build` 首屏 JS <300KB gzip。
// 约定：Track B 新增 `langpacks/{en,de,fr,it,es,ru,ja}.ts`（default export 或 named `pack`），
// 重跑 build 即自动接入，无需改本文件（import.meta.glob 静态发现）。

import type { LanguagePack, SourceLang } from '../types.js';
import { getFallbackPack } from './langpacks/fallback.js';

// glob 只做静态发现 + 懒加载（不 eager），fallback.ts 本身也命中但会被过滤。
const modules = import.meta.glob('./langpacks/*.ts');

const cache = new Map<SourceLang, LanguagePack>();

function loaderFor(lang: SourceLang): (() => Promise<unknown>) | null {
  const key = `./langpacks/${lang}.ts`;
  const load = modules[key];
  return (load as (() => Promise<unknown>) | undefined) ?? null;
}

export async function loadLanguagePack(lang: SourceLang): Promise<LanguagePack> {
  const hit = cache.get(lang);
  if (hit) return hit;
  // Track B 约定路径：./langpacks/{lang}.ts（default export 或 named `pack`）
  const load = loaderFor(lang);
  if (load) {
    try {
      const mod = (await load()) as { default?: LanguagePack; pack?: LanguagePack };
      const pack = mod?.default ?? mod?.pack ?? null;
      if (pack && typeof pack.segment === 'function' && typeof pack.lemmatize === 'function') {
        cache.set(lang, pack);
        return pack;
      }
    } catch {
      // 忽略，走 fallback
    }
  }
  const fb = getFallbackPack(lang);
  cache.set(lang, fb);
  return fb;
}
