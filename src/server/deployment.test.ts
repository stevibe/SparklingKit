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

  it("publishes the DGX lifecycle command in the bundle and stable channel", async () => {
    const [releaseWorkflow, runSiteWorkflow, installer, manager] = await Promise.all([
      fs.readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
      fs.readFile(new URL("../../.github/workflows/publish-run-site.yml", import.meta.url), "utf8"),
      fs.readFile(new URL("../../distribution/dgx/install.sh", import.meta.url), "utf8"),
      fs.readFile(new URL("../../distribution/dgx/sparklingkit-dgx", import.meta.url), "utf8"),
    ]);

    expect(releaseWorkflow).toContain("release-staging/dgx-stack/sparklingkit-dgx");
    expect(releaseWorkflow).not.toContain("release-assets/dgx-stack/");
    expect(releaseWorkflow).toContain("dgx-install.sh sparklingkit-dgx sparklingkit-dgx-stack.tar.gz");
    expect(runSiteWorkflow).toContain("run-site/dgx/stable/version.json");
    expect(runSiteWorkflow).toContain("release-assets/sparklingkit-dgx release-assets/sparklingkit-dgx-stack.tar.gz");
    expect(runSiteWorkflow).not.toContain("- .github/workflows/publish-run-site.yml");
    expect(installer).toContain("exec ./sparklingkit-dgx update");
    expect(manager).toContain("run_arguments=(start --refresh-images");
  });
});
