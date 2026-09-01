import { describe, expect, it } from "vitest";
import { defaultSettings } from "../server/config.js";
import { normalizeReferenceHost, referenceSettingsForHost } from "./reference-stack.js";

describe("reference stack settings", () => {
  it("accepts a hostname or a simple URL and rejects embedded connection details", () => {
    expect(normalizeReferenceHost("dgx-spark.local")).toBe("dgx-spark.local");
    expect(normalizeReferenceHost("http://192.0.2.10/")).toBe("192.0.2.10");
    expect(() => normalizeReferenceHost("http://dgx-spark.local:8331")).toThrow(/without credentials, a port, or a path/);
    expect(() => normalizeReferenceHost("dgx-spark.local/models")).toThrow(/without credentials, a port, or a path/);
  });

  it("maps one DGX host to all reference service ports", () => {
    const settings = referenceSettingsForHost(structuredClone(defaultSettings), "192.0.2.10", "split");
    expect(settings.setup).toMatchObject({ completed: true, mode: "split", onboardingVersion: 1 });
    expect(settings.setup.completedAt).toBeTruthy();
    expect(settings.systemStatus.baseUrl).toBe("http://192.0.2.10:8330");
    expect(settings.endpoints.llm.baseUrl).toBe("http://192.0.2.10:8331/v1");
    expect(settings.endpoints.ocr.baseUrl).toBe("http://192.0.2.10:8332/v1");
    expect(settings.endpoints.stt.baseUrl).toBe("http://192.0.2.10:8333/v1");
    expect(settings.endpoints.translation.baseUrl).toBe("http://192.0.2.10:8334/v1");
    expect(settings.endpoints.grounding.baseUrl).toBe("http://192.0.2.10:8335/v1");
    expect(settings.endpoints["image-generation"].baseUrl).toBe("http://192.0.2.10:8336/v1");
    expect(Object.values(settings.endpoints).every((endpoint) => endpoint.enabled)).toBe(true);
  });
});
