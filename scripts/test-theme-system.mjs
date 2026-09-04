import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../src/App.tsx");
const settings = read("../src/Settings.tsx");
const main = read("../src/main.tsx");
const themeRuntime = read("../src/theme.tsx");
const themeCss = read("../src/theme.css");
const appCss = read("../src/App.css");
const startupCss = read("../src/Startup.css");
const webRoot = read("../src/web/WebRoot.tsx");
const webCss = read("../src/web/WebRoot.css");
const viteConfig = read("../vite.config.ts");
const tsconfig = read("../tsconfig.json");
const historicalPalette = JSON.parse(read("./fixtures/softlifegreen-palette.json"));
const retiredThemeId = ["github", "blue"].join("-");

function declarationBlock(selectorFragment) {
  const start = themeCss.indexOf(`${selectorFragment} {`);
  assert.notEqual(start, -1, `Theme selector is missing: ${selectorFragment}`);
  const open = themeCss.indexOf("{", start);
  const close = themeCss.indexOf("}", open);
  assert.ok(open > start && close > open, `Theme block is malformed: ${selectorFragment}`);
  return themeCss.slice(open + 1, close);
}

function tokenMap(block) {
  const result = new Map();
  for (const match of block.matchAll(/^\s*(--kaigen-(?:theme|color)-[a-z0-9-]+):\s*([\s\S]*?);(?=\r?\n)/gmu)) {
    assert.ok(!result.has(match[1]), `Duplicate theme token: ${match[1]}`);
    result.set(match[1], match[2].trim().replace(/\s+/gu, " "));
  }
  return result;
}

const currentTokens = tokenMap(declarationBlock(':root[data-kaigen-theme="current"]'));
const softTokens = tokenMap(declarationBlock(':root[data-kaigen-theme="softlifegreen"]'));
assert.equal(currentTokens.size, 827, `Expected the complete palette contract, got ${currentTokens.size}`);
assert.deepEqual([...softTokens.keys()], [...currentTokens.keys()], "Both themes must define the exact same ordered token set");
assert.equal(
  [...softTokens.keys()].filter((token) => token.startsWith("--kaigen-theme-web-")).length,
  48,
  "The shared palette contract must retain the complete Web-specific token family",
);
assert.equal([...softTokens.keys()].filter((token) => token.startsWith("--kaigen-theme-startup-")).length, 124);
assert.equal([...softTokens.keys()].filter((token) => token.startsWith("--kaigen-color-")).length, 18);
assert.ok(
  [...currentTokens].filter(([token, value]) => softTokens.get(token) !== value).length >= 140,
  "The two themes must substitute values through the shared root contract",
);

const normalizedSoftContract = [...softTokens].map(([token, value]) => `${token}:${value}`).join("\n");
assert.equal(
  createHash("sha256").update(normalizedSoftContract).digest("hex"),
  "4cd2ce68d88f8633256d3e3a66b8a80f57324fd25e71d6e05d7016822e5156f1",
  "The pinned historical softlifegreen palette contract changed",
);

assert.deepEqual(
  { schema: historicalPalette.schema, sourceCommit: historicalPalette.sourceCommit, sourceBlob: historicalPalette.sourceBlob, colors: historicalPalette.colors.length },
  {
    schema: 1,
    sourceCommit: "4a06214b2ae30ae1d7e13f6993cb6c778655fe14",
    sourceBlob: "cba0562d630db3d61f39c2fcae8ad6884488f4fb",
    colors: 341,
  },
  "Historical palette provenance changed",
);
assert.equal(
  createHash("sha256").update(historicalPalette.colors.join("\n")).digest("hex"),
  "c4f40822b4e36b05c10841e88a1f2066c9ff70a7fed5662cfef8c1919894363e",
  "Historical source palette fixture changed",
);
const normalizedSoftColors = new Set(
  [...declarationBlock(':root[data-kaigen-theme="softlifegreen"]').matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/giu)]
    .map((match) => match[0].toLowerCase().replace(/\s+/gu, "")),
);
assert.deepEqual(
  historicalPalette.colors.filter((color) => !normalizedSoftColors.has(color)),
  [],
  "Every color from the pinned historical App.css blob must survive in softlifegreen",
);

const expectedHistoricalValues = new Map([
  ["--kaigen-theme-app-root-palette4-chat-", "#0e171e"],
  ["--kaigen-theme-app-root-palette4-message-", "#2d3d48"],
  ["--kaigen-theme-app-root-palette4-message-mine-", "#3b667e"],
  ["--kaigen-color-accent", "#4b8abd"],
  ["--kaigen-color-success", "#70e59a"],
  ["--kaigen-color-warning", "#f1c85b"],
  ["--kaigen-color-danger", "#e06a6a"],
  ["--kaigen-color-offline", "#9aa3aa"],
]);
for (const [tokenPrefix, expected] of expectedHistoricalValues) {
  const entries = [...softTokens].filter(([token]) => token === tokenPrefix || token.startsWith(tokenPrefix));
  const entry = tokenPrefix.endsWith("message-")
    ? entries.find(([token]) => /^--kaigen-theme-app-root-palette4-message-[a-z0-9]+$/u.test(token))
    : entries[0];
  assert.ok(entry, `Historical semantic token is missing: ${tokenPrefix}`);
  assert.equal(entry[1].toLowerCase(), expected, `Historical value changed for ${tokenPrefix}`);
}

const componentLiteral = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/giu;
assert.doesNotMatch(appCss, componentLiteral, "App.css must consume theme tokens instead of owning color literals");
assert.doesNotMatch(startupCss, componentLiteral, "Startup.css must consume theme tokens instead of owning color literals");
assert.doesNotMatch(webCss, componentLiteral, "WebRoot.css must consume theme tokens instead of owning color literals");
assert.match(appCss, /var\(--kaigen-theme-app-/u);
assert.match(startupCss, /var\(--kaigen-theme-startup-/u);
assert.match(webCss, /var\(--kaigen-theme-web-/u);

const consumedTokens = new Set(
  [...`${appCss}\n${startupCss}\n${webCss}`.matchAll(/var\((--kaigen-theme-[a-z0-9-]+)/gu)].map((match) => match[1]),
);
const componentTokens = new Set([...currentTokens.keys()].filter((token) => token.startsWith("--kaigen-theme-")));
assert.deepEqual(
  [...consumedTokens].filter((token) => !componentTokens.has(token)),
  [],
  "Every component theme-token reference must be defined by the shared contract",
);
assert.deepEqual(
  [...componentTokens].filter((token) => !consumedTokens.has(token)),
  [],
  "The shared contract must not accumulate detached palette tokens",
);
const semanticTokens = new Set([...currentTokens.keys()].filter((token) => token.startsWith("--kaigen-color-")));
const appSemanticTokens = new Set(
  [...appCss.matchAll(/var\((--kaigen-color-[a-z0-9-]+)/gu)].map((match) => match[1]),
);
const webSemanticTokens = new Set(
  [...webCss.matchAll(/var\((--kaigen-color-[a-z0-9-]+)/gu)].map((match) => match[1]),
);
assert.deepEqual([...appSemanticTokens].sort(), [...semanticTokens].sort(), "Desktop must consume the complete shared semantic layer");
assert.deepEqual(
  [...webSemanticTokens].filter((token) => !semanticTokens.has(token)),
  [],
  "Web semantic references must resolve through the shared Desktop/Web contract",
);

for (const [name, source] of Object.entries({ app, settings, main, themeRuntime, themeCss, appCss, startupCss, webRoot, webCss })) {
  assert.ok(!source.includes(retiredThemeId), `Retired theme ID survived in ${name}`);
}

assert.match(themeRuntime, /type KaigenTheme = "current" \| "softlifegreen"/u);
assert.match(themeRuntime, /return value === "softlifegreen" \? "softlifegreen" : DEFAULT_KAIGEN_THEME/u);
assert.match(themeRuntime, /localStorage\.getItem\(KAIGEN_THEME_STORAGE_KEY\)/u, "theme hydrates from durable browser storage on startup");
assert.match(themeRuntime, /useState<KaigenTheme>\(\(\) => initialTheme \?\? readInitialTheme\(\)\)/u, "persisted theme is the initial rendered theme");
assert.match(themeRuntime, /document\.documentElement\.dataset\.kaigenTheme = theme/u);
assert.match(themeRuntime, /localStorage\.setItem\(KAIGEN_THEME_STORAGE_KEY, theme\)/u);
assert.match(main, /<ThemeProvider><ProductRoot \/><\/ThemeProvider>/u);
assert.match(main, /import \{ ThemeProvider \} from "@kaigen\/theme"/u, "the entrypoint must use the canonical theme module identity");
assert.match(app, /import \{ useKaigenTheme \} from "@kaigen\/theme"/u, "MessengerApp must consume the canonical theme context");
assert.match(settings, /import \{ useKaigenTheme \} from "@kaigen\/theme"/u, "Settings must consume the canonical theme context");
assert.doesNotMatch(`${main}\n${app}\n${settings}`, /from "\.\/?theme"/u, "theme providers and consumers must not split across build-path aliases");
assert.match(tsconfig, /"@kaigen\/theme": \["\.\/src\/theme\.tsx"\]/u);
assert.match(viteConfig, /"@kaigen\/theme": source\("\.\/src\/theme\.tsx"\)/u);
assert.match(viteConfig, /name: "kaigen-singleton-theme-runtime"/u);
assert.match(viteConfig, /if \(themeModules\.size !== 1\)/u, "production builds must fail closed when the theme runtime is duplicated");
assert.doesNotMatch(app, /useState<[^>]*Theme/u, "App must not own a second theme state");
assert.doesNotMatch(settings, /useState<[^>]*Theme/u, "Settings must not own a second theme state");
assert.doesNotMatch(webRoot, /useState<[^>]*Theme/u, "WebRoot must inherit the shared theme owner");
assert.doesNotMatch(app, /data-kaigen-theme=/u, "Theme data must live on the common document ancestor");
assert.doesNotMatch(webRoot, /data-kaigen-theme=/u, "WebRoot must not create an independent theme ancestor");

assert.match(settings, /<option value="softlifegreen">Светлая<\/option><option value="current">Тёмная<\/option>/u);
assert.match(app, /data-theme="softlifegreen"/u);
assert.match(app, /data-theme="current"/u);
assert.doesNotMatch(app, /appearance: \{ \.\.\.appearance, theme \}/u, "Theme persistence must not race the document-level owner through profile layout state");
assert.doesNotMatch(app, /normalizeKaigenTheme/u, "Only ThemeProvider may hydrate persisted theme state");

const structuralDeclaration = /^\s*(?:display|width|height|min-width|min-height|max-width|max-height|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|gap|row-gap|column-gap|grid(?:-[a-z]+)?|flex(?:-[a-z]+)?|position|inset|top|right|bottom|left|align(?:-[a-z]+)?|justify(?:-[a-z]+)?|order|z-index|overflow(?:-[a-z]+)?|transform|translate|zoom|font-size|line-height|letter-spacing)\s*:/gmu;
assert.doesNotMatch(themeCss, structuralDeclaration, "The palette contract must not own geometry");

for (const [name, source] of Object.entries({ appCss, startupCss, webCss })) {
  assert.doesNotMatch(source, /data-kaigen-theme/u, `Component CSS must not branch by theme in ${name}`);
}

console.log(`THEME_SYSTEM_PASS themes=2 tokens=${currentTokens.size} owner=document-element component_literals=0`);
