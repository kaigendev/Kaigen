import nspell, { type NSpell } from "nspell";

type ConfigureMessage = { type: "configure"; configId: number; russian: boolean; english: boolean };
type CheckMessage = { type: "check"; configId: number; revision: number; text: string };
type SuggestMessage = { type: "suggest"; configId: number; requestId: number; tokenId: number; word: string };
type IncomingMessage = ConfigureMessage | CheckMessage | SuggestMessage;

const checkerPromises: Partial<Record<"ru" | "en", Promise<NSpell>>> = {};
let activeConfigId = 0;
let russianEnabled = false;
let englishEnabled = false;
let checkers: { ru?: NSpell; en?: NSpell } = {};
const WORD_PATTERN = /[\p{L}’'-]{2,}/gu;

function loadChecker(language: "ru" | "en"): Promise<NSpell> {
  if (!checkerPromises[language]) {
    const prefix = language === "ru" ? "ru-RU" : "en-US";
    checkerPromises[language] = Promise.all([
      fetch(`/dictionaries/${prefix}.aff`).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${prefix}.aff`);
        return response.text();
      }),
      fetch(`/dictionaries/${prefix}.dic`).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${prefix}.dic`);
        return response.text();
      }),
    ]).then(([aff, dic]) => nspell(aff, dic));
  }
  return checkerPromises[language]!;
}

function checkerForWord(word: string): NSpell | undefined {
  if (/[А-Яа-яЁё]/.test(word)) return russianEnabled ? checkers.ru : undefined;
  if (/[A-Za-z]/.test(word)) return englishEnabled ? checkers.en : undefined;
  return undefined;
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type === "configure") {
    activeConfigId = message.configId;
    russianEnabled = message.russian;
    englishEnabled = message.english;
    const configId = message.configId;
    void Promise.all([
      message.russian ? loadChecker("ru") : Promise.resolve(undefined),
      message.english ? loadChecker("en") : Promise.resolve(undefined),
    ]).then(([ru, en]) => {
      if (activeConfigId !== configId) return;
      checkers = { ru, en };
      self.postMessage({ type: "ready", configId });
    }).catch((error) => {
      if (activeConfigId === configId) self.postMessage({ type: "error", configId, message: String(error) });
    });
    return;
  }

  if (message.configId !== activeConfigId) return;
  if (message.type === "check") {
    const results = Array.from(message.text.matchAll(WORD_PATTERN), (match, index) => {
      const text = match[0];
      const checker = checkerForWord(text);
      return {
        id: message.revision * 1_000_000 + index,
        start: match.index,
        end: match.index + text.length,
        text,
        correct: !checker || checker.correct(text),
      };
    });
    self.postMessage({ type: "checked", configId: message.configId, revision: message.revision, results });
    return;
  }

  const checker = checkerForWord(message.word);
  const suggestions = checker ? checker.suggest(message.word).slice(0, 5) : [];
  self.postMessage({
    type: "suggestions",
    configId: message.configId,
    requestId: message.requestId,
    tokenId: message.tokenId,
    suggestions,
  });
};

export {};
