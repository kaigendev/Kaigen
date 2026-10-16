import React from "react";
import ReactDOM from "react-dom/client";
import "./assets/fonts/kaigen-fonts.css";
import ProductRoot from "@kaigen/root";
import { ThemeProvider } from "@kaigen/theme";
import "./theme.css";
import { initializeWebLaunch } from "./web/workspaceLaunch";
import { prepareBrandImage } from "./brandImage";

if (__KAIGEN_PRODUCT__ === "web") initializeWebLaunch();
void prepareBrandImage();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider><ProductRoot /></ThemeProvider>
  </React.StrictMode>,
);
