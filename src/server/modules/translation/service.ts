import { chatCompletion } from "../../ai.js";
import type { EndpointConfig } from "../../models.js";

export function translateContent(
  endpoint: EndpointConfig,
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  part?: { index: number; total: number },
  signal?: AbortSignal,
) {
  const partInstruction = part ? ` This is part ${part.index} of ${part.total}.` : "";
  return chatCompletion(endpoint, [
    {
      role: "system",
      content: "You are a precise professional translator. Preserve Markdown or HTML structure, tables, headings, links, names, numbers, and meaning. Return only the translated content without commentary.",
    },
    {
      role: "user",
      content: `Translate the following content from ${sourceLanguage} to ${targetLanguage}.${partInstruction}\n\n${text}`,
    },
  ], { temperature: 0.1, maxTokens: 8192 }, signal);
}
