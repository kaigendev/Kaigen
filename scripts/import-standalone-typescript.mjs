import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function importStandaloneTypeScript(moduleUrl) {
  const sourcePath = fileURLToPath(moduleUrl);
  const buildRoot = await mkdtemp(join(tmpdir(), "kaigen-typescript-test-"));
  try {
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      sourcePath,
      "--ignoreConfig",
      "--target", "ES2022",
      "--module", "ES2022",
      "--lib", "ES2022,DOM,DOM.Iterable",
      "--skipLibCheck",
      "--outDir", buildRoot,
      "--pretty", "false",
    ], { stdio: "pipe" });
    const outputName = basename(sourcePath).replace(/\.tsx?$/u, ".js");
    const javaScript = await readFile(join(buildRoot, outputName), "utf8");
    return await import(`data:text/javascript;base64,${Buffer.from(javaScript).toString("base64")}`);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}
