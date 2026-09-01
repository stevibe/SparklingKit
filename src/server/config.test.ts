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

  it("leaves a fresh installation unconfigured for first-run onboarding", () => {
    expect(defaultSettings.setup).toEqual({ completed: false, mode: "custom", onboardingVersion: 1 });
    expect(defaultSettings.systemStatus).toEqual({ baseUrl: "" });
    expect(Object.values(defaultSettings.endpoints).every((endpoint) => !endpoint.baseUrl && !endpoint.enabled)).toBe(true);
  });
});
