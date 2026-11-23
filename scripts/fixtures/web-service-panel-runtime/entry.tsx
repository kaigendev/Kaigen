import "../../../src/App.css";
import "../../../src/theme.css";
import React from "react";
import { createRoot } from "react-dom/client";
import WebRoot from "../../../src/web/WebRoot";
import { initializeWebLaunch } from "../../../src/web/workspaceLaunch";
import { getDefaultSendOnEnter } from "../../../src/platform/browser-input";

if (new URLSearchParams(location.search).has("launchRecovery")) initializeWebLaunch();
Object.assign(window, { tabletRuntime: { getDefaultSendOnEnter } });
createRoot(document.getElementById("root")!).render(<WebRoot />);
