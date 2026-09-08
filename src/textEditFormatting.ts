import type { ChatFormattingKind } from "./chatRichText";
import type { TextEditSelection } from "./textEditCommands";

export type TextEditFormattingSnapshot = Readonly<{
  activeKinds: readonly ChatFormattingKind[];
  isCurrent: () => boolean;
  apply: (kind: ChatFormattingKind) => boolean;
}>;

type FormattingReader = (selection: TextEditSelection) => TextEditFormattingSnapshot | null;

const owners = new WeakMap<object, FormattingReader>();

export function registerTextEditFormatting(target: object, reader: FormattingReader) {
  owners.set(target, reader);
  return () => {
    if (owners.get(target) === reader) owners.delete(target);
  };
}

export function snapshotTextEditFormatting(target: object, selection: TextEditSelection): TextEditFormattingSnapshot | null {
  if (selection.start >= selection.end) return null;
  const reader = owners.get(target);
  const snapshot = reader?.(selection);
  if (!reader || !snapshot) return null;
  const isCurrent = () => owners.get(target) === reader && snapshot.isCurrent();
  return {
    activeKinds: snapshot.activeKinds,
    isCurrent,
    apply: (kind) => isCurrent() && snapshot.apply(kind),
  };
}
