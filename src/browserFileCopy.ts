import "./browserFileCopy.css";

type CopyWindow = Window & {
  showDirectoryPicker?: (options: { mode: "readwrite"; id: string }) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (options: { suggestedName: string; id: string }) => Promise<FileSystemFileHandle>;
};

export type FileCopyResult = "saved" | "downloaded" | "shared" | "cancelled";

function shareFileCopy(file: File, language: "ru" | "en", signal?: AbortSignal): Promise<FileCopyResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "browser-file-share";
    const title = document.createElement("h2");
    title.textContent = language === "ru" ? "Сохранить файл" : "Save file";
    const filename = document.createElement("p");
    filename.className = "browser-file-share-name";
    filename.textContent = file.name;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = language === "ru"
      ? "В системном меню выберите «Сохранить в Файлы» или приложение."
      : "Choose Save to Files or an app in the system menu.";
    const actions = document.createElement("div");
    actions.className = "browser-file-share-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = language === "ru" ? "Отмена" : "Cancel";
    const share = document.createElement("button");
    share.type = "button";
    share.textContent = language === "ru" ? "Открыть меню сохранения" : "Open save menu";
    actions.append(cancel, share);
    dialog.append(title, filename, status, actions);
    dialog.setAttribute("aria-label", title.textContent);
    let settled = false;
    const finish = (result: FileCopyResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      const restoreFocus = dialog.contains(document.activeElement) || document.activeElement === document.body;
      signal?.removeEventListener("abort", abort);
      dialog.close();
      dialog.remove();
      if (restoreFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish("cancelled", signal?.reason ?? new DOMException("Aborted", "AbortError"));
    cancel.addEventListener("click", () => finish("cancelled"));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish("cancelled"); });
    dialog.addEventListener("close", () => finish("cancelled"));
    share.addEventListener("click", () => {
      // The original bytes are ready before this gesture; do not await a fetch
      // before invoking the native share sheet or navigate the standalone app.
      share.disabled = true;
      try {
        void navigator.share({ files: [file] }).then(() => finish("shared"), (error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") { finish("cancelled"); return; }
          status.textContent = language === "ru" ? "Не удалось открыть меню. Повторите попытку." : "Could not open the menu. Try again.";
          share.disabled = false;
        });
      } catch {
        status.textContent = language === "ru" ? "Не удалось открыть меню. Повторите попытку." : "Could not open the menu. Try again.";
        share.disabled = false;
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    share.focus({ preventScroll: true });
  });
}

function copyName(name: string, sequence: number) {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim() || "file";
  if (!sequence) return safe;
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 ? safe.slice(dot).slice(0, 32) : "";
  const stem = (dot > 0 ? safe.slice(0, dot) : safe).slice(0, 80);
  return `${stem} (${sequence})${extension}`;
}

async function unusedFile(directory: FileSystemDirectoryHandle, name: string) {
  for (let sequence = 0; sequence < 10_000; sequence += 1) {
    const candidate = copyName(name, sequence);
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
      return directory.getFileHandle(candidate, { create: true });
    }
  }
  throw new Error("FILE_COPY_NAME_UNAVAILABLE");
}

/** Invoke directly from a user gesture, before downloading any original bytes. */
export async function saveBrowserFileCopy(
  name: string,
  readOriginal: () => Promise<Blob>,
  signal?: AbortSignal,
  language: "ru" | "en" = "en",
): Promise<FileCopyResult> {
  const picker = window as CopyWindow;
  let directory: FileSystemDirectoryHandle | undefined;
  let selectedFile: FileSystemFileHandle | undefined;
  try {
    // Opening the picker first retains transient activation on Chromium.
    if (picker.showDirectoryPicker) directory = await picker.showDirectoryPicker({ mode: "readwrite", id: "kaigen-file-copy" });
    else if (picker.showSaveFilePicker) selectedFile = await picker.showSaveFilePicker({ suggestedName: copyName(name, 0), id: "kaigen-file-copy" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    throw error;
  }
  signal?.throwIfAborted();
  const blob = await readOriginal();
  signal?.throwIfAborted();
  if (directory || selectedFile) {
    const file = selectedFile ?? await unusedFile(directory!, name);
    signal?.throwIfAborted();
    const writable = await file.createWritable();
    try {
      await writable.write(blob);
      signal?.throwIfAborted();
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    return "saved";
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone
    || window.matchMedia("(display-mode: standalone)").matches;
  if (ios && standalone) {
    const file = new File([blob], copyName(name, 0), { type: blob.type || "application/octet-stream" });
    // A blob download can replace an iOS Home Screen app with its download
    // viewer. Use the native Files/share menu while retaining the chat document.
    if (!navigator.share || !navigator.canShare?.({ files: [file] })) throw new Error("FILE_COPY_UNSUPPORTED");
    return shareFileCopy(file, language, signal);
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = copyName(name, 0);
  document.body.append(link);
  link.click();
  link.remove();
  // Download dispatch consumes the URL asynchronously in Safari/Firefox.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
