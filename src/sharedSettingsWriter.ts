/** Keep shared Settings saves ordered across panel unmount/remount. */
export function createSharedSettingsWriter<T>(
  save: (settings: T) => Promise<T>,
  read: () => Promise<T>,
) {
  let pending: Promise<unknown> = Promise.resolve();
  return {
    save(settings: T): Promise<T> {
      const snapshot = structuredClone(settings);
      const request = pending.then(() => save(snapshot), () => save(snapshot));
      pending = request;
      return request;
    },
    async read(): Promise<T> {
      await pending.catch(() => {});
      return read();
    },
  };
}

