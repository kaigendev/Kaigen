import React from "react";
import ReactDOM from "react-dom/client";
import ProductRoot from "@kaigen/root";
import { ThemeProvider } from "@kaigen/theme";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider><ProductRoot /></ThemeProvider>
  </React.StrictMode>,
);
