import { describe, expect, it } from "vitest";
import { BUNDLED_SERVICE_CATALOG, defaultSettings } from "./config.js";

describe("bundled service catalog", () => {
  it("keeps the status monitor and model services on their assigned ports", () => {
    expect(Object.fromEntries(Object.entries(BUNDLED_SERVICE_CATALOG).map(([key, service]) => [key, service.port]))).toEqual({
      systemStatus: 8330,
      llm: 8331,
      ocr: 8332,
      stt: 8333,
      translation: 8334,
      grounding: 8335,
      imageGeneration: 8336,
    });
  });

  it("makes the system monitor part of the saved settings model", () => {
    expect(defaultSettings.systemStatus).toEqual({ baseUrl: "http://192.0.2.10:8330" });
  });
});
