import React from "react";
import {createRoot} from "react-dom/client";
import WebRoot from "../../../src/web/WebRoot";
import {ThemeProvider} from "@kaigen/theme";
import "../../../src/theme.css";
createRoot(document.getElementById("root")!).render(<ThemeProvider><WebRoot /></ThemeProvider>);
