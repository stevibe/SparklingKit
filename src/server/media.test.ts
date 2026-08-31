import { describe, expect, it } from "vitest";
import { runCommand, srtTimestamp, vttTimestamp } from "./media.js";

describe("subtitle timestamps", () => {
  it("formats SRT timestamps", () => {
    expect(srtTimestamp(3661.234)).toBe("01:01:01,234");
  });

  it("formats VTT timestamps", () => {
    expect(vttTimestamp(2.005)).toBe("00:00:02.005");
  });

  it("clamps negative values", () => {
    expect(srtTimestamp(-4)).toBe("00:00:00,000");
  });

  it("terminates an active media command when the job is stopped", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const command = runCommand(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], 5000, controller.signal);
    setTimeout(() => controller.abort(), 25);
    await expect(command).rejects.toMatchObject({ name: "AbortError", message: "Job stopped" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
