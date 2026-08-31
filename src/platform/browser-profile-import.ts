const ZIP32_MAX = 0xffff_ffff;

export const MAX_QTOX_FOLDER_FILES = 4096;
export const MAX_QTOX_FOLDER_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_QTOX_MATERIAL_BYTES = 256 * 1024 * 1024;
export const MAX_QTOX_PROFILE_BYTES = 25 * 1024 * 1024;
export const MAX_QTOX_RELATIVE_PATH_BYTES = 1024;

const textEncoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

export type BrowserQtoxProfile = {
  name: string;
  relativePath: string;
};

type BrowserQtoxFile = {
  file: File;
  relativePath: string;
};

type StoredZipEntry = BrowserQtoxFile & {
  nameBytes: Uint8Array<ArrayBuffer>;
};

function zipError(code: string): Error {
  return new Error(code);
}

function rawRelativePath(file: File) {
  return (file.webkitRelativePath || file.name).replace(/\\/gu, "/").normalize("NFC");
}

function pathSegments(path: string) {
  if (!path || path.startsWith("/") || path.includes("\0")) throw zipError("QTOX_FOLDER_PATH_INVALID");
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw zipError("QTOX_FOLDER_PATH_INVALID");
  }
  return segments;
}

function describeFolder(files: readonly File[]): BrowserQtoxFile[] {
  if (files.length === 0 || files.length > MAX_QTOX_FOLDER_FILES) throw zipError("QTOX_FOLDER_FILE_COUNT_INVALID");
  const raw = files.map((file) => ({ file, segments: pathSegments(rawRelativePath(file)) }));
  const selectedRoot = raw.every(({ segments }) => segments.length > 1 && segments[0] === raw[0]?.segments[0])
    ? raw[0]?.segments[0]
    : null;
  const seen = new Set<string>();
  return raw.map(({ file, segments }) => {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_QTOX_FOLDER_BYTES) {
      throw zipError("QTOX_FOLDER_FILE_SIZE_INVALID");
    }
    const relativePath = (selectedRoot ? segments.slice(1) : segments).join("/");
    const encoded = textEncoder.encode(relativePath);
    if (encoded.byteLength === 0 || encoded.byteLength > MAX_QTOX_RELATIVE_PATH_BYTES) {
      throw zipError("QTOX_FOLDER_PATH_INVALID");
    }
    const identity = relativePath.toLocaleLowerCase("en-US");
    if (seen.has(identity)) throw zipError("QTOX_FOLDER_DUPLICATE_PATH");
    seen.add(identity);
    return { file, relativePath };
  });
}

export function listQtoxFolderProfiles(files: readonly File[]): BrowserQtoxProfile[] {
  return describeFolder(files)
    .filter(({ file, relativePath }) => relativePath.toLocaleLowerCase("en-US").endsWith(".tox")
      && file.size > 0
      && file.size <= MAX_QTOX_PROFILE_BYTES)
    .map(({ relativePath }) => ({
      name: relativePath.slice(relativePath.lastIndexOf("/") + 1, -4) || "qTox profile",
      relativePath,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en", { sensitivity: "base" }));
}

function archiveEntries(files: readonly File[], selectedProfilePath: string): StoredZipEntry[] {
  const described = describeFolder(files);
  const selected = described.find(({ relativePath }) => relativePath === selectedProfilePath);
  if (!selected || !selectedProfilePath.toLocaleLowerCase("en-US").endsWith(".tox")
    || selected.file.size === 0 || selected.file.size > MAX_QTOX_PROFILE_BYTES) {
    throw zipError("QTOX_PROFILE_SELECTION_INVALID");
  }
  const slash = selectedProfilePath.lastIndexOf("/");
  const parent = slash < 0 ? "" : selectedProfilePath.slice(0, slash + 1);
  const stem = selectedProfilePath.slice(parent.length, -4);
  const selectedLower = selectedProfilePath.toLocaleLowerCase("en-US");
  const historyLower = `${parent}${stem}.db`.toLocaleLowerCase("en-US");
  const settingsLower = `${parent}${stem}.ini`.toLocaleLowerCase("en-US");
  const avatarsLower = `${parent}avatars/`.toLocaleLowerCase("en-US");
  const avatarsPrefixLength = parent.length + "avatars/".length;
  let totalBytes = 0;
  const entries = described.flatMap(({ file, relativePath }) => {
    const lower = relativePath.toLocaleLowerCase("en-US");
    if (lower !== selectedLower && lower !== historyLower && lower !== settingsLower && !lower.startsWith(avatarsLower)) return [];
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_QTOX_MATERIAL_BYTES) {
      throw zipError("QTOX_FOLDER_TOTAL_SIZE_INVALID");
    }
    const archivePath = lower.startsWith(avatarsLower)
      ? `avatars/${relativePath.slice(avatarsPrefixLength)}`
      : relativePath.slice(parent.length);
    const nameBytes = textEncoder.encode(archivePath);
    return [{ file, relativePath: archivePath, nameBytes }];
  });
  if (entries.length === 0 || totalBytes === 0) throw zipError("QTOX_PROFILE_SELECTION_INVALID");
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en", { sensitivity: "base" }));
}

async function crc32(file: File) {
  const reader = file.stream().getReader();
  let checksum = 0xffff_ffff;
  let bytesRead = 0;
  let nextYield = 8 * 1024 * 1024;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > file.size) throw zipError("QTOX_FOLDER_FILE_CHANGED");
      for (const byte of value) checksum = crcTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
      if (bytesRead >= nextYield) {
        nextYield += 8 * 1024 * 1024;
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (bytesRead !== file.size) throw zipError("QTOX_FOLDER_FILE_CHANGED");
  return (checksum ^ 0xffff_ffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

export async function createStoredQtoxZip(files: readonly File[], selectedProfilePath: string): Promise<Blob> {
  const entries = archiveEntries(files, selectedProfilePath);
  const parts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0;
  let centralBytes = 0;
  for (const entry of entries) {
    const checksum = await crc32(entry.file);
    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x0403_4b50);
    u16(localView, 4, 20);
    u16(localView, 6, 0x0800);
    u16(localView, 8, 0);
    u16(localView, 10, 0);
    u16(localView, 12, 33);
    u32(localView, 14, checksum);
    u32(localView, 18, entry.file.size);
    u32(localView, 22, entry.file.size);
    u16(localView, 26, entry.nameBytes.byteLength);
    u16(localView, 28, 0);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x0201_4b50);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, 0x0800);
    u16(centralView, 10, 0);
    u16(centralView, 12, 0);
    u16(centralView, 14, 33);
    u32(centralView, 16, checksum);
    u32(centralView, 20, entry.file.size);
    u32(centralView, 24, entry.file.size);
    u16(centralView, 28, entry.nameBytes.byteLength);
    u16(centralView, 30, 0);
    u16(centralView, 32, 0);
    u16(centralView, 34, 0);
    u16(centralView, 36, 0);
    u32(centralView, 38, 0);
    u32(centralView, 42, offset);

    parts.push(local, entry.nameBytes, entry.file);
    centralParts.push(central, entry.nameBytes);
    offset += local.byteLength + entry.nameBytes.byteLength + entry.file.size;
    centralBytes += central.byteLength + entry.nameBytes.byteLength;
    if (offset > ZIP32_MAX || centralBytes > ZIP32_MAX) throw zipError("QTOX_FOLDER_ZIP32_LIMIT");
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x0605_4b50);
  u16(endView, 4, 0);
  u16(endView, 6, 0);
  u16(endView, 8, entries.length);
  u16(endView, 10, entries.length);
  u32(endView, 12, centralBytes);
  u32(endView, 16, offset);
  u16(endView, 20, 0);
  if (offset + centralBytes + end.byteLength > ZIP32_MAX) throw zipError("QTOX_FOLDER_ZIP32_LIMIT");
  return new Blob([...parts, ...centralParts, end], { type: "application/zip" });
}
