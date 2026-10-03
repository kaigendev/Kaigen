import * as base from "../chat-geometry-runtime/app-platform";
export * from "../chat-geometry-runtime/app-platform";
export const platformCapabilities = { ...base.platformCapabilities, nativeFilesystem: false };
export const tabletCommands: Array<{ command: string; args: any }> = [];
const stateKey = "disposable-tablet-local-state";
export async function invoke<T>(command: string, args: any = {}): Promise<T> {
  tabletCommands.push({ command, args: structuredClone(args) });
  if (command === "load_local_state") {
    const initial: any = await base.invoke(command, args);
    const stored = sessionStorage.getItem(stateKey);
    if (stored) return JSON.parse(stored) as T;
    const explicit = new URLSearchParams(location.search).get("saved");
    return { ...initial, activeChat: `tox-${"B".repeat(64)}`, ...(explicit === "true" || explicit === "false" ? { sendOnEnter: explicit === "true" } : {}) } as T;
  }
  if (command === "save_local_state") sessionStorage.setItem(stateKey, JSON.stringify(args.state));
  return base.invoke<T>(command, args);
}
base.geometrySetMenuProfiles(true);
const imageId = base.geometryAppendImage(1, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2kAAAAASUVORK5CYII=", true);
Object.assign(window, { appTabletFixture: {
  commands: tabletCommands, sent: base.geometrySentPayloads, imageId,
  readSaved: () => JSON.parse(sessionStorage.getItem(stateKey) ?? "null"),
} });
