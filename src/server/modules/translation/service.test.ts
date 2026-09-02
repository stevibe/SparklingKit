import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointConfig } from "../../models.js";
import { splitTranslationText } from "./executor.js";
import { translateContent, translationOutputTokenBudget } from "./service.js";

describe("translation requests", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve());
    server = undefined;
  });

  it("uses the Hy-MT2 prompt shape and bounded output budget", async () => {
    let body: Record<string, unknown> = {};
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "Bonjour." } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    const endpoint: EndpointConfig = {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "Hy-MT2-1.8B-FP8",
      apiKey: "",
      enabled: true,
    };

    await expect(translateContent(endpoint, "Hello.", "auto-detect", "French")).resolves.toBe("Bonjour.");

    expect(body).toMatchObject({
      model: "Hy-MT2-1.8B-FP8",
      temperature: 0.7,
      max_tokens: 128,
      messages: [{ role: "user" }],
    });
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("repetition_penalty");
    expect(body.messages).toHaveLength(1);
    expect((body.messages as Array<{ content: string }>)[0].content).not.toContain("from auto-detect");
  });

  it("caps output tokens and splits default background work into manageable requests", () => {
    expect(translationOutputTokenBudget("a".repeat(100_000))).toBe(4_096);
    const chunks = splitTranslationText("A".repeat(14_000), 2_000);
    expect(chunks).toHaveLength(3);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(6_000);
    expect(chunks.join("")).toHaveLength(14_000);
  });
});
