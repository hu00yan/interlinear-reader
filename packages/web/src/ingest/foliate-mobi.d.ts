/** Narrow adapter surface for the pinned Foliate parser. */
export class MOBI {
  constructor(options: { unzlib?: (data: Uint8Array) => Promise<Uint8Array> });
  /** Zero-based embedded resource offset; respects combo files' shared resource base. */
  loadResource(index: number): Promise<ArrayBuffer>;
  open(file: Blob): Promise<{
    metadata: { title?: string };
    sections: Array<{ linear?: string; createDocument?: () => Promise<Document> }>;
    destroy(): void;
  }>;
}
