import { describe, expect, it } from "vitest";
import { translationLanguages } from "./ModulesPage";

describe("Hy-MT2 language catalog", () => {
  it("contains every language and variety documented by the model", () => {
    expect(translationLanguages).toHaveLength(38);
    expect(translationLanguages).toContainEqual(["Traditional Chinese", "zh-Hant"]);
    expect(translationLanguages).toContainEqual(["Tibetan", "bo"]);
    expect(translationLanguages).toContainEqual(["Kazakh", "kk"]);
    expect(translationLanguages).toContainEqual(["Mongolian", "mn"]);
    expect(translationLanguages).toContainEqual(["Uyghur", "ug"]);
    expect(translationLanguages).toContainEqual(["Cantonese", "yue"]);
  });
});
