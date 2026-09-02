import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DGX Spark model images", () => {
  it("keeps the Hy-MT2 image tag aligned with its required Transformers runtime", async () => {
    const [dockerfile, compose] = await Promise.all([
      fs.readFile(new URL("../../services/dgx-models/hy-mt2/Dockerfile", import.meta.url), "utf8"),
      fs.readFile(new URL("../../compose.dgx.yaml", import.meta.url), "utf8"),
    ]);
    const runtimeVersion = dockerfile.match(/"transformers==([^"]+)"/)?.[1];
    const imageVersion = compose.match(/image:\s+sparklingkit\/hy-mt2-1\.8b-fp8:transformers-([^\s]+)/)?.[1];

    expect(runtimeVersion).toBe("5.6.0");
    expect(imageVersion).toBe(runtimeVersion);
  });
});
