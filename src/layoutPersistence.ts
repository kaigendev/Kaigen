export type PortableLayoutSnapshot = Record<string, unknown>;

type LayoutLoader = () => Promise<PortableLayoutSnapshot | null>;
type LayoutSaver = (state: PortableLayoutSnapshot) => Promise<unknown>;

function copyRecord(value: unknown, label: string): PortableLayoutSnapshot {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return { ...(value as PortableLayoutSnapshot) };
}

export function resolvePortableLayoutValue<T>(
  state: PortableLayoutSnapshot,
  key: string,
  fallback: () => T,
) {
  const persisted = Object.prototype.hasOwnProperty.call(state, key);
  return { persisted, value: persisted ? state[key] : fallback() };
}

export function canLeaveStartupSplash<T>(
  themeReady: boolean,
  splashDone: boolean,
  startup: T | null | undefined,
): startup is T {
  return themeReady && splashDone && startup != null;
}

export function createLayoutPersistence() {
  let loadPromise: Promise<PortableLayoutSnapshot> | null = null;
  let snapshot: PortableLayoutSnapshot | null = null;
  let writeTail: Promise<void> = Promise.resolve();

  const hydrate = (load: LayoutLoader) => {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(load)
        .then((loaded) => {
          snapshot = copyRecord(loaded, "persisted layout");
          return { ...snapshot };
        });
    }
    return loadPromise.then(() => ({ ...(snapshot ?? {}) }));
  };

  const retainPatch = (patch: PortableLayoutSnapshot) => {
    if (!snapshot) return false;
    snapshot = { ...snapshot, ...copyRecord(patch, "layout patch") };
    return true;
  };

  const savePatch = (patch: PortableLayoutSnapshot, save: LayoutSaver) => {
    const queuedPatch = copyRecord(patch, "layout patch");
    const operation = writeTail.then(async () => {
      if (!loadPromise) throw new Error("portable layout must hydrate before save");
      await loadPromise;
      const next = { ...(snapshot ?? {}), ...queuedPatch };
      // Keep the newest desired full snapshot even when this particular write
      // fails, so a later queued patch can recover it without losing fields.
      snapshot = next;
      await save({ ...next });
      return { ...next };
    });
    writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return {
    hydrate,
    isHydrated: () => snapshot !== null,
    readSnapshot: () => snapshot ? { ...snapshot } : null,
    retainPatch,
    savePatch,
  };
}

const portableLayout = createLayoutPersistence();

export const hydratePortableLayout = portableLayout.hydrate;
export const isPortableLayoutHydrated = portableLayout.isHydrated;
export const readPortableLayoutSnapshot = portableLayout.readSnapshot;
export const retainPortableLayoutPatch = portableLayout.retainPatch;
export const savePortableLayoutPatch = portableLayout.savePatch;
