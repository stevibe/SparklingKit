import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transcribeAudio } from "./ai.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((work) => work())); });

describe("ASR requests", () => {
  it("sends the configured completion-token limit", async () => {
    let requestBody = "";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = Buffer.concat(chunks).toString("utf8");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ text: "hello" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const folder = await fs.mkdtemp(path.join(tmpdir(), "sparklingkit-ai-"));
    cleanup.push(() => fs.rm(folder, { recursive: true, force: true }));
    const audio = path.join(folder, "sample.wav");
    await fs.writeFile(audio, "test audio");

    await transcribeAudio(
      { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-asr", apiKey: "" },
      audio,
      0,
      { maxCompletionTokens: 777, timeoutMs: 2000 },
    );

    expect(requestBody).toContain('name="max_completion_tokens"');
    expect(requestBody).toContain("777");
  });
});
