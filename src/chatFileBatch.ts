export const MAX_CHAT_FILE_BATCH = 5;
export const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024;

export type ChatFileCandidate = {
  name: string;
  size: number;
};

export type ChatFileRejection<T extends ChatFileCandidate> = {
  file: T;
  reason: "empty" | "too_large" | "unreadable";
};

export type ChatFileBatchAdmission<T extends ChatFileCandidate> = {
  accepted: T[];
  rejected: ChatFileRejection<T>[];
  selectedCount: number;
  tooMany: boolean;
};

export function admitChatFileBatch<T extends ChatFileCandidate>(
  files: Iterable<T>,
): ChatFileBatchAdmission<T> {
  const selected = Array.from(files);
  if (selected.length > MAX_CHAT_FILE_BATCH) {
    return { accepted: [], rejected: [], selectedCount: selected.length, tooMany: true };
  }

  const accepted: T[] = [];
  const rejected: ChatFileRejection<T>[] = [];
  for (const file of selected) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      rejected.push({ file, reason: "empty" });
    } else if (file.size > MAX_CHAT_FILE_BYTES) {
      rejected.push({ file, reason: "too_large" });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, rejected, selectedCount: selected.length, tooMany: false };
}

export function formatChatFileBatchNotice<T extends ChatFileCandidate>(
  admission: ChatFileBatchAdmission<T>,
  language: "ru" | "en",
): string | null {
  if (admission.tooMany) {
    return language === "en"
      ? `You can add no more than ${MAX_CHAT_FILE_BATCH} files at once. Selected: ${admission.selectedCount}. No files were added.`
      : `За один раз можно добавить не более ${MAX_CHAT_FILE_BATCH} файлов. Выбрано: ${admission.selectedCount}. Файлы не добавлены.`;
  }
  if (!admission.rejected.length) return null;
  return admission.rejected.map(({ file, reason }) => {
    const name = file.name.trim() || (language === "en" ? "unnamed file" : "файл без имени");
    if (reason === "too_large") {
      return language === "en"
        ? `File “${name}” was not added: it exceeds the 25 MB limit.`
        : `Файл «${name}» не добавлен: размер превышает лимит 25 МБ.`;
    }
    if (reason === "unreadable") {
      return language === "en"
        ? `File “${name}” was not added: it could not be read.`
        : `Файл «${name}» не добавлен: его не удалось прочитать.`;
    }
    return language === "en"
      ? `File “${name}” was not added: empty files cannot be sent.`
      : `Файл «${name}» не добавлен: пустые файлы нельзя отправлять.`;
  }).join("\n");
}
