/** Narrow adapter surface for the pinned text-only Foliate parser. */
export class MOBI {
  constructor(options: { unzlib?: (data: Uint8Array) => Promise<Uint8Array> });
  open(file: Blob): Promise<{
    metadata: { title?: string };
    sections: Array<{ linear?: string; createDocument?: () => Promise<Document> }>;
    destroy(): void;
  }>;
}
