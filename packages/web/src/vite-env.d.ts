/// <reference types="vite/client" />

// Intl.Segmenter 最小声明（TS lib ES2020 无此类型，运行时 Chrome/Safari/FF 均已支持）
declare namespace Intl {
  type SegmenterOptions = { granularity?: 'grapheme' | 'word' | 'sentence'; localeMatcher?: string };
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
