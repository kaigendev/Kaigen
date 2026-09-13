/** Extract a complete Tox address, including its two-byte checksum. */
export function clipboardToxId(text: string): string | null {
  const candidates = text.slice(0, 65_536).matchAll(/(?:^|[^0-9a-f])([0-9a-f]{76})(?![0-9a-f])/giu);
  for (const candidate of candidates) {
    const id = candidate[1].toUpperCase();
    const checksum = [0, 0];
    for (let index = 0; index < 36; index += 1) {
      checksum[index % 2] ^= Number.parseInt(id.slice(index * 2, index * 2 + 2), 16);
    }
    if (checksum.every((value, index) => value === Number.parseInt(id.slice(72 + index * 2, 74 + index * 2), 16))) return id;
  }
  return null;
}

/** Owns one form opening. Late clipboard replies never replace later input. */
export class ContactClipboardPrefill {
  private revision = 0;

  cancel(): void { this.revision += 1; }

  begin(readClipboard: () => Promise<string>, apply: (toxId: string) => void): void {
    const revision = ++this.revision;
    // Start the browser permission request inside the original click gesture.
    try {
      void readClipboard().then((text) => {
        if (revision !== this.revision) return;
        const toxId = clipboardToxId(text);
        if (toxId) apply(toxId);
      }).catch(() => {});
    } catch {
      // Missing clipboard access must not prevent the form from opening.
    }
  }
}
