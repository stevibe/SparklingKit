import { chatCompletion } from "../../ai.js";
import type { EndpointConfig } from "../../models.js";

export const TRANSLATION_PREVIEW_CHARACTER_LIMIT = 2_000;

export function translationOutputTokenBudget(text: string) {
  let asciiCharacters = 0;
  let otherCharacters = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) asciiCharacters += 1;
    else otherCharacters += 1;
  }
  const estimatedInputTokens = (asciiCharacters / 3.5) + otherCharacters;
  return Math.min(4_096, Math.max(128, Math.ceil((estimatedInputTokens * 1.5) + 64)));
}

export function translateContent(
  endpoint: EndpointConfig,
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  part?: { index: number; total: number },
  signal?: AbortSignal,
) {
  const partInstruction = part ? ` This is part ${part.index} of ${part.total}.` : "";
  const sourceInstruction = sourceLanguage === "auto-detect" ? "" : ` from ${sourceLanguage}`;
  return chatCompletion(endpoint, [{
    role: "user",
    content: `Translate the following content${sourceInstruction} into ${targetLanguage}.${partInstruction} Preserve Markdown or HTML structure, tables, headings, links, names, numbers, and meaning. Only output the translated result without any additional explanation:\n\n${text}`,
  }], {
    temperature: 0.7,
    maxTokens: translationOutputTokenBudget(text),
  }, signal);
}
