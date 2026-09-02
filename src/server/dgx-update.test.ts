import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const managerSource = new URL("../../distribution/dgx/sparklingkit-dgx", import.meta.url);

async function writeExecutable(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode: 0o755 });
}

async function writeStack(
  root: string,
  version: string,
  marker: string,
  behavior: { modern?: boolean; start?: number; stop?: number } = {},
) {
  await fs.mkdir(path.join(root, "services/dgx-models"), { recursive: true });
  await fs.mkdir(path.join(root, "services/dgx-status"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, "compose.yaml"), `${marker} compose\n`),
    fs.writeFile(path.join(root, "compose.spark.yaml"), `${marker} spark\n`),
    fs.writeFile(path.join(root, "compose.dgx.yaml"), `${marker} dgx\n`),
    fs.writeFile(path.join(root, "LICENSE"), `${marker} license\n`),
    fs.writeFile(path.join(root, ".sparklingkit-dgx-version"), `${version}\n`),
    fs.writeFile(path.join(root, "services/dgx-models/marker"), `${marker} models\n`),
    fs.writeFile(path.join(root, "services/dgx-status/marker"), `${marker} status\n`),
    fs.copyFile(managerSource, path.join(root, "sparklingkit-dgx")),
  ]);
  await fs.chmod(path.join(root, "sparklingkit-dgx"), 0o755);
  await writeExecutable(path.join(root, "scripts/start-dgx-models.sh"), `#!/usr/bin/env bash\nset -euo pipefail\nROOT="$(cd "$(dirname "${"${BASH_SOURCE[0]}"}")/.." && pwd)"\nprintf '${marker} %s\\n' "$*" >> "$ROOT/run.log"\ncase "${"${1:-start}"}" in\n  start) exit ${behavior.start ?? 0} ;;\n  stop) exit ${behavior.stop ?? 0} ;;\n  *) exit 0 ;;\nesac\n`);
  const lifecycleOptions = behavior.modern === false ? "" : "# --skip-pull\n# --force-recreate\n";
  await writeExecutable(path.join(root, "scripts/start-dgx-spark.sh"), `#!/usr/bin/env bash\n${lifecycleOptions}exit 0\n`);
}

async function createRelease(
  endpoint: string,
  version: string,
  marker: string,
  behavior: { modern?: boolean; start?: number; stop?: number } = {},
) {
  const tree = path.join(endpoint, "tree");
  await writeStack(tree, version, marker, behavior);
  const bundle = path.join(endpoint, "sparklingkit-dgx-stack.tar.gz");
  await execFile("tar", ["-czf", bundle, "-C", tree, "."]);
  const digest = createHash("sha256").update(await fs.readFile(bundle)).digest("hex");
  await fs.writeFile(path.join(endpoint, "SHA256SUMS"), `${digest}  sparklingkit-dgx-stack.tar.gz\n`);
  await fs.writeFile(path.join(endpoint, "version.json"), JSON.stringify({ version }));
}

describe("hosted DGX stack updates", () => {
  let root = "";
  let project = "";
  let endpoint = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-dgx-update-"));
    project = path.join(root, "project");
    endpoint = path.join(root, "release");
    await fs.mkdir(endpoint, { recursive: true });
    await writeStack(project, "0.1.1", "old");
    await fs.mkdir(path.join(project, "data/dgx-models"), { recursive: true });
    await fs.writeFile(path.join(project, "data/dgx-models/keep-me"), "model data\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("installs a verified stack and preserves model data", async () => {
    await createRelease(endpoint, "0.1.2", "new");
    await execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], {
      env: { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` },
    });

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("new dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.2\n");
    expect(await fs.readFile(path.join(project, "data/dgx-models/keep-me"), "utf8")).toBe("model data\n");
    expect(await fs.readFile(path.join(project, ".previous-dgx-stack/compose.dgx.yaml"), "utf8")).toBe("old dgx\n");
    expect((await fs.readFile(path.join(project, "run.log"), "utf8")).trim().split("\n")).toEqual([
      "old stop",
      "new start --refresh-images",
    ]);
  });

  it("restores the previous stack when refreshed services fail", async () => {
    await createRelease(endpoint, "0.1.2", "broken", { start: 1 });
    await expect(execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], {
      env: { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` },
    })).rejects.toThrow();

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("old dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.1\n");
    expect(await fs.readFile(path.join(project, "data/dgx-models/keep-me"), "utf8")).toBe("model data\n");
    const log = await fs.readFile(path.join(project, "run.log"), "utf8");
    expect(log.trim().split("\n")).toEqual([
      "old stop",
      "broken start --refresh-images",
      "broken stop",
      "old start --skip-download --skip-pull --force-recreate",
    ]);
  });

  it("supports update, explicit rollback, and update again", async () => {
    await createRelease(endpoint, "0.1.2", "new");
    const environment = { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` };
    await execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], { env: environment });
    await execFile("bash", [path.join(project, "sparklingkit-dgx"), "rollback"], { env: environment });

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("old dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.1\n");
    expect(await fs.readFile(path.join(project, "data/dgx-models/keep-me"), "utf8")).toBe("model data\n");

    await execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], { env: environment });
    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("new dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.2\n");
    expect((await fs.readFile(path.join(project, "run.log"), "utf8")).trim().split("\n")).toEqual([
      "old stop",
      "new start --refresh-images",
      "new stop",
      "old start --skip-download --skip-pull --force-recreate",
      "old stop",
      "new start --refresh-images",
    ]);
  });

  it("does not replace stack files when the running services cannot stop", async () => {
    await writeStack(project, "0.1.1", "old", { stop: 1 });
    await createRelease(endpoint, "0.1.2", "new");
    await expect(execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], {
      env: { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` },
    })).rejects.toThrow();

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("old dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.1\n");
    expect((await fs.readFile(path.join(project, "run.log"), "utf8")).trim().split("\n")).toEqual([
      "old stop",
      "old start --skip-download --skip-pull --force-recreate",
    ]);
    await expect(fs.stat(path.join(project, ".sparklingkit-dgx-transaction"))).rejects.toThrow();
  });

  it("restores the current release when the rollback target cannot start", async () => {
    await writeStack(project, "0.1.1", "old", { start: 1 });
    await createRelease(endpoint, "0.1.2", "new");
    const environment = { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` };
    await execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], { env: environment });
    await expect(execFile("bash", [path.join(project, "sparklingkit-dgx"), "rollback"], {
      env: environment,
    })).rejects.toThrow();

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("new dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.2\n");
    expect(await fs.readFile(path.join(project, "data/dgx-models/keep-me"), "utf8")).toBe("model data\n");
    expect((await fs.readFile(path.join(project, "run.log"), "utf8")).trim().split("\n")).toEqual([
      "old stop",
      "new start --refresh-images",
      "new stop",
      "old start --skip-download --skip-pull --force-recreate",
      "old stop",
      "new start --skip-download --skip-pull --force-recreate",
    ]);
  });

  it("rejects a bundle with a mismatched checksum before replacing files", async () => {
    await createRelease(endpoint, "0.1.2", "untrusted");
    await fs.writeFile(path.join(endpoint, "SHA256SUMS"), `${"0".repeat(64)}  sparklingkit-dgx-stack.tar.gz\n`);
    await expect(execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], {
      env: { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` },
    })).rejects.toThrow();

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("old dgx\n");
    await expect(fs.stat(path.join(project, ".previous-dgx-stack"))).rejects.toThrow();
  });

  it("recovers an interrupted update before allowing another change", async () => {
    await writeStack(path.join(project, ".previous-dgx-stack"), "0.1.1", "old");
    await writeStack(project, "0.1.2", "partial");
    await fs.writeFile(path.join(project, ".sparklingkit-dgx-transaction"), "update\n");

    await expect(execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], {
      env: { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` },
    })).rejects.toThrow();

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("old dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.1\n");
    expect((await fs.readFile(path.join(project, "run.log"), "utf8")).trim().split("\n")).toEqual([
      "partial stop",
      "old start --skip-download --skip-pull --force-recreate",
    ]);
    await expect(fs.stat(path.join(project, ".sparklingkit-dgx-transaction"))).rejects.toThrow();
    await expect(fs.stat(path.join(project, ".sparklingkit-dgx-update.lock"))).rejects.toThrow();
  });

  it("recovers the current release after an interrupted rollback", async () => {
    await writeStack(path.join(project, ".rollback-current-dgx-stack"), "0.1.2", "current");
    await writeStack(project, "0.1.1", "partial");
    await fs.writeFile(path.join(project, ".sparklingkit-dgx-transaction"), "rollback\n");

    await expect(execFile("bash", [path.join(project, "sparklingkit-dgx"), "rollback"])).rejects.toThrow();

    expect(await fs.readFile(path.join(project, "compose.dgx.yaml"), "utf8")).toBe("current dgx\n");
    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.2\n");
    expect((await fs.readFile(path.join(project, "run.log"), "utf8")).trim().split("\n")).toEqual([
      "partial stop",
      "current start --skip-download --skip-pull --force-recreate",
    ]);
    await expect(fs.stat(path.join(project, ".sparklingkit-dgx-transaction"))).rejects.toThrow();
    await expect(fs.stat(path.join(project, ".rollback-current-dgx-stack"))).rejects.toThrow();
  });

  it("removes a stale change lock before updating", async () => {
    await createRelease(endpoint, "0.1.2", "new");
    const lockDirectory = path.join(project, ".sparklingkit-dgx-update.lock");
    await fs.mkdir(lockDirectory);
    await fs.writeFile(path.join(lockDirectory, "pid"), "999999999\n");

    await execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], {
      env: { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` },
    });

    expect(await fs.readFile(path.join(project, ".sparklingkit-dgx-version"), "utf8")).toBe("0.1.2\n");
    await expect(fs.stat(lockDirectory)).rejects.toThrow();
  });

  it("uses the legacy no-build start mode when restoring an older stack", async () => {
    await writeStack(project, "0.1.1", "legacy", { modern: false });
    await createRelease(endpoint, "0.1.2", "broken", { start: 1 });

    await expect(execFile("bash", [path.join(project, "sparklingkit-dgx"), "update"], {
      env: { ...process.env, SPARKLINGKIT_DGX_RELEASE_URL: `file://${endpoint}` },
    })).rejects.toThrow();

    expect((await fs.readFile(path.join(project, "run.log"), "utf8")).trim().split("\n")).toEqual([
      "legacy stop",
      "broken start --refresh-images",
      "broken stop",
      "legacy start --skip-download --skip-build",
    ]);
  });
});
