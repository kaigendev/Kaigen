import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = "127.0.0.1";

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const product = mode === "web" ? "web" : "desktop";
  const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

  return {
    plugins: [react()],
    resolve: {
      // Windows portable builds use a temporary ASCII drive alias for the
      // repository. Force hook-bearing packages to one resolver identity so
      // the aliased entrypoint and real-path source cannot bundle two Reacts.
      dedupe: ["react", "react-dom"],
      alias: {
        "@kaigen/platform": source(`./src/platform/${product}.ts`),
        "@kaigen/root": source(product === "web" ? "./src/web/WebRoot.tsx" : "./src/RootApp.tsx"),
      },
    },
    define: {
      __KAIGEN_PRODUCT__: JSON.stringify(product),
    },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
