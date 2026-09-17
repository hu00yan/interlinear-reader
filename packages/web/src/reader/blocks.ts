import type { Book, BookChapter } from "../types.js";
import type { AnnotatedParagraph } from "./render.js";

/** Images occupy one indivisible geometry position, but zero language tokens. */
export function flowLength(p: AnnotatedParagraph): number {
  return p.image ? 1 : p.tokens.length;
}

/** Merge only at the presentation boundary; original indices remain text-only. */
export function chapterFlow(
  chapter: BookChapter,
  annotated: AnnotatedParagraph[],
  resolveImage: (src: string) => string | undefined
): { flow: AnnotatedParagraph[]; orig: number[] } {
  const flow: AnnotatedParagraph[] = [];
  const orig: number[] = [];
  let pi = 0;
  for (const block of chapter.blocks ??
    chapter.paragraphs.map((text) => ({ kind: "p" as const, text }))) {
    if (block.kind === "img") {
      const url = resolveImage(block.src);
      if (!url) continue;
      flow.push({ text: "", tokens: [], image: { src: url, alt: block.alt ?? "", height: 200 } });
      orig.push(-1);
    } else {
      const p = annotated[pi];
      if (p?.tokens.length) {
        flow.push(p);
        orig.push(pi);
      }
      pi++;
    }
  }
  return { flow, orig };
}

/** Session-owned URL pool, allocated only when a chapter enters the reader. */
export class BookImageUrls {
  private book: Book | null = null;
  private urls = new Map<string, string>();

  setBook(book: Book | null): void {
    if (book === this.book) return;
    this.dispose();
    this.book = book;
  }

  get(src: string): string | undefined {
    const blob = this.book?.assets?.[src];
    if (!blob?.type.startsWith("image/")) return undefined;
    let url = this.urls.get(src);
    if (!url) {
      url = URL.createObjectURL(blob);
      this.urls.set(src, url);
    }
    return url;
  }

  dispose(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.book = null;
  }
}
