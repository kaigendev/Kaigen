import React from "react";
import { createRoot } from "react-dom/client";
import ProductRoot from "../../../src/RootApp";
import { ThemeProvider } from "@kaigen/theme";
import "../../../src/theme.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider><ProductRoot /></ThemeProvider>
  </React.StrictMode>,
);
