export const translationLanguages = [
  ["Chinese", "zh"], ["English", "en"], ["French", "fr"], ["Portuguese", "pt"], ["Spanish", "es"], ["Japanese", "ja"], ["Turkish", "tr"], ["Russian", "ru"], ["Arabic", "ar"], ["Korean", "ko"], ["Thai", "th"], ["Italian", "it"], ["German", "de"], ["Vietnamese", "vi"], ["Malay", "ms"], ["Indonesian", "id"], ["Filipino", "tl"], ["Hindi", "hi"], ["Traditional Chinese", "zh-Hant"], ["Polish", "pl"], ["Czech", "cs"], ["Dutch", "nl"], ["Khmer", "km"], ["Burmese", "my"], ["Persian", "fa"], ["Gujarati", "gu"], ["Urdu", "ur"], ["Telugu", "te"], ["Marathi", "mr"], ["Hebrew", "he"], ["Bengali", "bn"], ["Tamil", "ta"], ["Ukrainian", "uk"], ["Tibetan", "bo"], ["Kazakh", "kk"], ["Mongolian", "mn"], ["Uyghur", "ug"], ["Cantonese", "yue"],
] as const;

const supportedTranslationLanguageNames: readonly string[] = translationLanguages.map(([name]) => name);
export const translationPreferenceKey = "sparklingkit.translation.preferences";

export interface TranslationPreferences {
  source: string;
  target: string;
  recent: string[];
}

export function savedTranslationPreferences(): TranslationPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(translationPreferenceKey) || "{}") as Partial<TranslationPreferences>;
    return {
      source: parsed.source === "auto-detect" || supportedTranslationLanguageNames.includes(parsed.source || "") ? parsed.source! : "auto-detect",
      target: supportedTranslationLanguageNames.includes(parsed.target || "") ? parsed.target! : "Traditional Chinese",
      recent: parsed.recent?.filter((language) => supportedTranslationLanguageNames.includes(language)).slice(0, 4) || ["Traditional Chinese", "English"],
    };
  } catch {
    return { source: "auto-detect", target: "Traditional Chinese", recent: ["Traditional Chinese", "English"] };
  }
}
