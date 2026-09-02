import { describe, expect, it, vi } from "vitest";
import { createClientId } from "./client-id";

describe("createClientId", () => {
  it("uses the browser's native random UUID when available", () => {
    const randomUUID = vi.fn(() => "native-uuid");

    expect(createClientId({ randomUUID })).toBe("native-uuid");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("creates a UUID when randomUUID is unavailable on an HTTP origin", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0);
      return bytes;
    });

    expect(createClientId({ getRandomValues })).toBe("00000000-0000-4000-8000-000000000000");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
