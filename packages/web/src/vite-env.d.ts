/// <reference types="vite/client" />

// 构建指纹（vite.config define 注入）：设置页展示，部署新鲜度探测比对用。
declare const __ILR_BUILD__: string;

// Intl.Segmenter 最小声明（TS lib ES2020 无此类型，运行时 Chrome/Safari/FF 均已支持）
declare namespace Intl {
  type SegmenterOptions = {
    granularity?: "grapheme" | "word" | "sentence";
    localeMatcher?: string;
  };
  interface SegmentData {
    segment: string;
    index: number;
    isWordLike?: boolean;
  }
  class Segmenter {
    constructor(locale?: string | string[], options?: SegmenterOptions);
    segment(input: string): Iterable<SegmentData>;
  }
}
