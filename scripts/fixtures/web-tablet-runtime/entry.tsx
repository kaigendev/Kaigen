import React from "react";
import { createRoot } from "react-dom/client";
import WebRoot from "../../../src/web/WebRoot";
import { getDefaultSendOnEnter } from "../../../src/platform/browser-input";

Object.assign(window, { tabletRuntime: { getDefaultSendOnEnter } });
createRoot(document.getElementById("root")!).render(<WebRoot />);
