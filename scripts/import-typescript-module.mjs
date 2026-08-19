import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tscPath = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

export async function importTypeScriptModule(sourceUrl) {
  const sourcePath = fileURLToPath(sourceUrl);
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "kaigen-ts-module-"));
  try {
    const result = spawnSync(process.execPath, [
      tscPath,
      "--ignoreConfig",
      sourcePath,
      "--module", "esnext",
      "--target", "es2020",
      "--moduleResolution", "bundler",
      "--outDir", outputDirectory,
      "--declaration", "false",
      "--sourceMap", "false",
      "--noEmitOnError", "true",
      "--skipLibCheck",
      "--pretty", "false",
    ], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`TypeScript module compilation failed (${result.status ?? result.signal}):\n${result.stdout}${result.stderr}`);
    }
    const outputPath = path.join(outputDirectory, path.basename(sourcePath).replace(/\.tsx?$/u, ".js"));
    const compiled = await readFile(outputPath, "utf8");
    return await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
