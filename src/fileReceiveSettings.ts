export type FileReceiveSettings = {
  denyAll: boolean;
  autoAcceptImages: boolean;
  showImages: boolean;
  autoAcceptAny: boolean;
  maxAutoBytes: number;
  maxConcurrent: number;
};

export const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024;

export const DEFAULT_FILE_RECEIVE_SETTINGS: FileReceiveSettings = Object.freeze({
  denyAll: false,
  autoAcceptImages: true,
  showImages: true,
  autoAcceptAny: true,
  maxAutoBytes: 24 * 1024 * 1024,
  maxConcurrent: 2,
});

export function normalizeFileReceiveSettings(value: Partial<FileReceiveSettings>): FileReceiveSettings {
  const maxAutoBytes = Number.isFinite(value.maxAutoBytes)
    ? Math.max(0, Math.min(MAX_CHAT_FILE_BYTES, Math.floor(value.maxAutoBytes!)))
    : DEFAULT_FILE_RECEIVE_SETTINGS.maxAutoBytes;
  const maxConcurrent = Number.isFinite(value.maxConcurrent)
    ? Math.max(1, Math.min(2, Math.floor(value.maxConcurrent!)))
    : DEFAULT_FILE_RECEIVE_SETTINGS.maxConcurrent;
  return {
    denyAll: value.denyAll ?? DEFAULT_FILE_RECEIVE_SETTINGS.denyAll,
    autoAcceptImages: value.autoAcceptImages ?? DEFAULT_FILE_RECEIVE_SETTINGS.autoAcceptImages,
    showImages: value.showImages ?? DEFAULT_FILE_RECEIVE_SETTINGS.showImages,
    autoAcceptAny: value.autoAcceptAny ?? DEFAULT_FILE_RECEIVE_SETTINGS.autoAcceptAny,
    maxAutoBytes,
    maxConcurrent,
  };
}

export function shouldAutoAcceptIncomingFile(
  settings: FileReceiveSettings,
  name: string,
  size: number,
): boolean {
  if (settings.denyAll || !Number.isSafeInteger(size) || size < 0 || size > MAX_CHAT_FILE_BYTES || size > settings.maxAutoBytes) return false;
  const image = /\.(?:png|jpe?g)$/iu.test(name.trim());
  return settings.autoAcceptAny || (settings.autoAcceptImages && image);
}

/** Preserve user action order and the owner captured before a profile switch. */
export function createFileReceiveSettingsWriter(
  save: (profileId: string, settings: FileReceiveSettings) => Promise<FileReceiveSettings>,
) {
  let pending: Promise<unknown> = Promise.resolve();
  return (profileId: string, settings: FileReceiveSettings): Promise<FileReceiveSettings> => {
    const snapshot = normalizeFileReceiveSettings(settings);
    const request = pending.then(
      () => save(profileId, snapshot),
      () => save(profileId, snapshot),
    );
    pending = request;
    return request;
  };
}
