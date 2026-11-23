import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { navigationFixture, webSession } from "./session";

export default function RootApp({ registerBeforeWorkspaceLock }: { registerBeforeWorkspaceLock?: (handler: () => Promise<void>) => () => void }) {
  useLayoutEffect(() => registerBeforeWorkspaceLock?.(async () => {
    navigationFixture.record("prepare");
    await navigationFixture.pause("prepare");
    if (navigationFixture.failPrepare) throw new Error("PROFILE_NICKNAME_SAVE_FAILED");
    navigationFixture.record("prepared");
  }), [registerBeforeWorkspaceLock]);
  const navigationMode = new URLSearchParams(location.search).has("navigation");
  return <div data-created-workspace="true" data-fixture-identity={webSession.getIdentifier()} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
    <button>App action</button>
    {navigationMode && <>
      <a id="fixture-link-a" href={`#k=${"a".repeat(48)}`}>Workspace A</a>
      <a id="fixture-link-b" href={`#k=${"b".repeat(48)}`}>Workspace B</a>
      <a id="fixture-link-c" href={`#k=${"c".repeat(48)}`}>Workspace C</a>
      {createPortal(<button id="fixture-portal-action" style={{ position: "fixed", inset: "12px 12px auto auto", zIndex: 100000 }} onClick={() => navigationFixture.record("portal-action")}>Portal action</button>, document.body)}
    </>}
    <textarea style={{ marginTop: "auto" }} aria-label="Composer" />
  </div>;
}
