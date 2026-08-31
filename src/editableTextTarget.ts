const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password"]);

export function isEditableTextTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  const editable = target.closest("input, textarea, [contenteditable]");
  if (editable instanceof HTMLTextAreaElement) return true;
  if (editable instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(editable.type);
  return editable instanceof HTMLElement && editable.isContentEditable;
}
