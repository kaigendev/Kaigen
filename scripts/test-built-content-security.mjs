import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const requestedOutputs = process.argv.slice(2);
const outputs = requestedOutputs.length > 0 ? requestedOutputs : ["dist", "dist-web"];
assert.deepEqual(
  outputs.filter((output) => !["dist", "dist-web"].includes(output)),
  [],
  "built content security accepts only canonical desktop/Web output names",
);

for (const output of outputs) {
  const html = await readFile(new URL(`../${output}/index.html`, import.meta.url), "utf8");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/iu, `${output} contains an inline event attribute`);
  assert.doesNotMatch(html, /javascript\s*:/iu, `${output} contains a javascript: URL`);
  assert.doesNotMatch(html, /<(?:base|iframe|object|embed)\b/iu, `${output} contains an executable embedding element`);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//iu, `${output} references a remote executable asset`);

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  assert.ok(scripts.length > 0, `${output} contains no application script`);
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc=["'][^"']+["']/iu, `${output} contains an inline script`);
    assert.match(attributes, /\btype=["']module["']/iu, `${output} contains a non-module script`);
    assert.equal(body.trim(), "", `${output} contains an inline script body`);
    assert.doesNotMatch(attributes, /\bsrc=["'](?:data:|blob:|https?:)/iu, `${output} contains a non-local script source`);
  }
}

console.log(`Built content security contracts passed (${outputs.join(", ")}).`);
