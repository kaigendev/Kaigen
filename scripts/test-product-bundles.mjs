import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);

async function bundleText(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(entries.map(async (entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return bundleText(url);
    return /\.(?:html|css|js|mjs)$/u.test(entry.name) ? readFile(url, "utf8") : "";
  }));
  return contents.join("\n");
}

const [desktop, web] = await Promise.all([
  bundleText(new URL("dist/", projectRoot)),
  bundleText(new URL("dist-web/", projectRoot)),
]);

for (const marker of ["kaigen-browser-auth-v1", "X-Kaigen-CSRF", ".web-service-bar{", "UI_LEASE_OCCUPIED"]) {
  assert.ok(web.includes(marker), `web bundle must contain ${marker}`);
  assert.ok(!desktop.includes(marker), `desktop bundle must exclude ${marker}`);
}
for (const marker of ["__TAURI_INTERNALS__", "ipc.localhost", "plugin:dialog", "plugin:notification"]) {
  assert.ok(!web.includes(marker), `web bundle must exclude Tauri marker ${marker}`);
}

console.log("desktop/web bundle composition: 12 assertions passed");
