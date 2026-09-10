import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { chatLinkSegments, normalizeChatLink } = await importTypeScriptModule(new URL("../src/chatLinks.ts", import.meta.url));
let assertions = 0;
function equal(actual, expected, label) { assertions += 1; assert.deepEqual(actual, expected, label); }

for (const [input, output] of [
  ["https://example.test/a?x=1#fragment", "https://example.test/a?x=1#fragment"],
  ["HTTP://Example.test/path", "http://example.test/path"],
  ["www.example.test/page", "https://www.example.test/page"],
  ["https://пример.рф/путь", new URL("https://пример.рф/путь").href],
  ["https://[::1]/path", "https://[::1]/path"],
]) equal(normalizeChatLink(input), output, `normalize allowed link: ${input}`);

for (const input of ["", "javascript:alert(1)", "data:text/html,test", "file:///tmp/test", "ftp://example.test/a", "//example.test", "https:example.test", "https://", "www.", "https://a@evil.test", "https://user:password@evil.test", "https://example.test\\@evil.test", "https://example.test/\nnext", " https://example.test", "https://exam\u0000ple.test", "https://exam\u202eple.test"]) {
  equal(normalizeChatLink(input), null, "unsafe or ambiguous address is not actionable");
}

for (const [input, expected] of [
  ["Смотри (https://example.test/a_(b)). www.example.test/path, дальше", ["https://example.test/a_(b)", "https://www.example.test/path"]],
  ["😀 «https://пример.рф/путь»; http://example.test/x?y=1#tail!", [new URL("https://пример.рф/путь").href, "http://example.test/x?y=1#tail!"]],
  ["See https://example.test/[one]{two}))]}", ["https://example.test/[one]%7Btwo%7D"]],
  ["https://example.test/path!", ["https://example.test/path!"]],
  ["https://example.test/?token=abc!", ["https://example.test/?token=abc!"]],
  ["See https://example.test/?token=abc! next", ["https://example.test/?token=abc!"]],
  ["See (https://example.test/?token=abc!#tail!?).", ["https://example.test/?token=abc!#tail!?"]],
  ["mail@www.example.test abcwww.example.test abchttps://example.test javascript:alert(1) <script>alert(1)</script>", []],
  ["https://user@example.test/x and https://example.test\\@evil.test", []],
  ["", []],
]) {
  const segments = chatLinkSegments(input);
  equal(segments.map((item) => item.href).filter(Boolean), expected, "only complete safe addresses are actionable");
  equal(segments.map((item) => item.text).join(""), input, "segmentation preserves original message and punctuation");
  equal(segments.every((item) => input.slice(item.start, item.end) === item.text), true, "ranges keep UTF-16 offsets used by formatting and search");
}
const fullAddress = `https://example.test/${"long-path/".repeat(200)}?query=${"0123456789".repeat(200)}#complete-fragment`;
equal(chatLinkSegments(fullAddress)[0].href, fullAddress, "visual clamp must never truncate the complete address");
const punctuation = ")".repeat(20_000);
equal(chatLinkSegments(`See https://example.test/a${punctuation}`).map((item) => item.text).join(""), `See https://example.test/a${punctuation}`, "large malformed suffix stays lossless with linear punctuation scanning");
console.log(`chat links: ${assertions} assertions passed`);

let platformAssertions = 0;
for (const platform of ["desktop", "web"]) {
  const source = await readFile(new URL(`../src/platform/${platform}.ts`, import.meta.url), "utf8");
  const body = source.match(/export function openUrl\(url: string\) \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(body, "load the actual platform openUrl function at its dependency boundary");
  const calls = [];
  const open = new Function("normalizeChatLink", "invoke", "window", "url", body).bind(null, normalizeChatLink,
    (command, args) => { calls.push([command, args]); return Promise.resolve(); },
    { open: (...args) => calls.push(args) });
  for (const input of ["https://EXAMPLE.test/path", "www.example.test/page", `${fullAddress}!?`]) {
    calls.length = 0;
    await open(input);
    const target = normalizeChatLink(input);
    assert.deepEqual(calls, platform === "desktop" ? [["open_external_url", { url: target }]] : [[target, "_blank", "noopener,noreferrer"]]);
    platformAssertions += 1;
  }
  for (const input of ["javascript:alert(1)", "ftp://example.test", "https://user@example.test", "https://example.test/\nnext"]) {
    calls.length = 0;
    await assert.rejects(open(input), /EXTERNAL_URL_NOT_ALLOWED/u);
    assert.equal(calls.length, 0, `${platform}: unsafe input cannot reach an opener`);
    platformAssertions += 2;
  }
  if (platform === "desktop") {
    calls.length = 0;
    await open("https://github.com/kaigendev/Kaigen");
    assert.deepEqual(calls, [["open_project_repository", undefined]], "the established repository command is retained");
    platformAssertions += 1;
  }
}
console.log(`chat link platform boundary: ${platformAssertions} assertions passed`);
