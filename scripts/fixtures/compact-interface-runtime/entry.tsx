import React from "react";
import { createRoot } from "react-dom/client";
import RootApp from "../../../src/RootApp";
import { ThemeProvider } from "@kaigen/theme";
import "../../../src/theme.css";
createRoot(document.getElementById("root")!).render(<ThemeProvider><RootApp /></ThemeProvider>);
