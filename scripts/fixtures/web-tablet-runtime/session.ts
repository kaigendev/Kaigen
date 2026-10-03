export const calls: unknown[] = [];
Object.assign(window, { workspaceCalls: calls });
export const webSession = {
  onWorkspace: () => () => {},
  onUpgradeRequired: () => () => {},
  verifyBuildIdentity: async () => {},
  createWorkspace: async (args: unknown) => {
    calls.push(args);
    if (new URLSearchParams(location.search).has("fail")) throw new Error("DISPOSABLE_CREATION_FAILURE ".repeat(15));
    return { identifier: "a".repeat(48) };
  },
  login: async () => {},
};
