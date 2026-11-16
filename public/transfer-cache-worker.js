self.onmessage = async ({ data: { workspace, name, blob, chunkBytes } }) => {
  try {
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(".kaigen-transfer-cache");
    const directory = await cache.getDirectoryHandle(workspace);
    const file = await directory.getFileHandle(name);
    const writer = await file.createSyncAccessHandle();
    try {
      await writer.truncate(0);
      for (let position = 0; position < blob.size; position += chunkBytes) {
        const bytes = await blob.slice(position, position + chunkBytes).arrayBuffer();
        if (writer.write(bytes, { at: position }) !== bytes.byteLength) {
          throw new Error("TRANSFER_SIZE_MISMATCH");
        }
      }
      await writer.flush();
    } finally {
      await writer.close();
    }
    self.postMessage(true);
  } catch {
    self.postMessage(false);
  }
};
