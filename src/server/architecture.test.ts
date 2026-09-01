import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("v2 workflow architecture", () => {
  let root = "";
  let server: Server | undefined;
  const previousDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sparklingkit-v2-"));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve());
    server = undefined;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function writeLegacyOcrJob() {
    const store = await import("./store.js");
    await store.initializeData();
    const id = "legacy-ocr-job";
    const jobRoot = store.jobDir(id);
    await Promise.all(["input", "work", "output"].map((folder) => fs.mkdir(path.join(jobRoot, folder), { recursive: true })));
    await fs.writeFile(path.join(jobRoot, "input", "001-source.pdf"), "source");
    await fs.writeFile(path.join(jobRoot, "output", "document.md"), "# Source\n\nHello world.\n");
    const now = new Date().toISOString();
    await store.atomicWriteJson(path.join(jobRoot, "job.json"), {
      id,
      type: "pdf",
      status: "done",
      createdAt: now,
      updatedAt: now,
      title: "Source.pdf",
      progress: 100,
      stage: "Complete",
      inputs: [{ name: "Source.pdf", storedName: "001-source.pdf", mimeType: "application/pdf", size: 6 }],
      outputFiles: ["document.md"],
      warnings: [],
      params: {},
    });
    return { store, id };
  }

  it("projects a v1 job into modules, workflow runs, and typed artifacts", async () => {
    const { store, id } = await writeLegacyOcrJob();
    const job = await store.readJob(id);
    expect(job.schemaVersion).toBe(2);
    expect(job.moduleId).toBe("ocr");
    expect(job.workflowId).toBe("ocr.pdf");
    expect(job.runs).toHaveLength(1);
    expect(job.artifacts.map((artifact) => artifact.kind)).toEqual(["source-pdf", "document"]);
  });

  it("runs translation as a derived workflow without replacing the OCR result", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "# 來源\n\n你好，世界。" } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const { store, id } = await writeLegacyOcrJob();
    const settings = await store.readSettings();
    await store.writeSettings({
      ...settings,
      endpoints: {
        ...settings.endpoints,
        translation: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "translator", apiKey: "" },
      },
    });
    const job = await store.readJob(id);
    const source = job.artifacts.find((artifact) => artifact.path === "output/document.md")!;
    const created = await store.createWorkflowRun(id, "translation", "translation.default", { artifactId: source.id, targetLanguage: "Traditional Chinese" }, [source.id]);
    const processor = await import("./processor.js");
    await processor.processRun(id, created.run.id);

    const completed = await store.readJob(id);
    expect(completed.status).toBe("done");
    expect(completed.outputFiles).toEqual(["document.md", "translation.traditional-chinese.md"]);
    const translated = completed.artifacts.find((artifact) => artifact.kind === "translation")!;
    expect(translated.derivedFrom).toEqual([source.id]);
    expect(await fs.readFile(path.join(store.jobDir(id), translated.path), "utf8")).toContain("你好");
  });

  it("runs quick text translation as a durable translation job", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "早上好。" } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("./store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({ ...settings, endpoints: { ...settings.endpoints, translation: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "translator", apiKey: "" } } });
    const created = await store.createTextTranslationJob("Good morning.", "auto-detect", "Traditional Chinese");
    const processor = await import("./processor.js");
    await processor.processRun(created.id, created.runs[0].id);

    const completed = await store.readJob(created.id);
    expect(completed.moduleId).toBe("translation");
    expect(completed.status).toBe("done");
    expect(completed.artifacts.map((artifact) => artifact.kind)).toEqual(["text", "translation"]);
    expect(await fs.readFile(path.join(store.jobDir(created.id), "output", "translation.traditional-chinese.md"), "utf8")).toContain("早上好");
  });

  it("translates an uploaded text file as a durable source artifact", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "<h1>每日工作</h1>" } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("./store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({ ...settings, endpoints: { ...settings.endpoints, translation: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "translator", apiKey: "" } } });
    const uploadPath = path.join(root, "upload.html");
    await fs.writeFile(uploadPath, "<h1>Daily work</h1>", "utf8");
    const upload = {
      originalname: "daily-work.html",
      mimetype: "text/html",
      path: uploadPath,
      size: 19,
    } as Express.Multer.File;
    const created = await store.createFileTranslationJob(upload, "English", "Traditional Chinese");
    const processor = await import("./processor.js");
    await processor.processRun(created.id, created.runs[0].id);

    const completed = await store.readJob(created.id);
    expect(completed.moduleId).toBe("translation");
    expect(completed.artifacts[0]).toMatchObject({ name: "daily-work.html", kind: "text", role: "source" });
    expect(completed.outputFiles).toEqual(["translation.traditional-chinese.html"]);
    expect(await fs.readFile(path.join(store.jobDir(created.id), "output", "translation.traditional-chinese.html"), "utf8")).toContain("每日工作");
  });

  it("creates an image artifact through the text-to-image workflow", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8XcAAAAASUVORK5CYII=", "base64");
    let requestBody = "";
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = Buffer.concat(chunks).toString("utf8");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("./store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({
      ...settings,
      endpoints: {
        ...settings.endpoints,
        "image-generation": { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "image-model", apiKey: "" },
      },
    });
    const created = await store.createTextToImageJob("A paper spacecraft above Macau", { size: "1536x1024" });
    const processor = await import("./processor.js");
    await processor.processRun(created.id, created.runs[0].id);

    const completed = await store.readJob(created.id);
    expect(completed.status).toBe("done");
    expect(completed.moduleId).toBe("text-to-image");
    expect(completed.outputFiles).toEqual(["generated-image.png"]);
    expect(JSON.parse(requestBody)).toMatchObject({ model: "image-model", prompt: "A paper spacecraft above Macau", size: "1536x1024" });
    const generated = completed.artifacts.find((artifact) => artifact.kind === "generated-image")!;
    expect(generated.derivedFrom).toEqual([completed.artifacts.find((artifact) => artifact.role === "source")!.id]);
    expect(await fs.readFile(path.join(store.jobDir(created.id), generated.path))).toEqual(png);
  });

  it("grounds text queries and creates a framed image plus normalized annotations", async () => {
    let requestUrl = "";
    let requestBody = "";
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      requestUrl = request.url || "";
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = Buffer.concat(chunks).toString("utf8");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          answer: "<ref>SparklingKit</ref><box><30><40><400><120></box>",
          image_width: 640,
          image_height: 480,
          boxes: [{ x1: 19.2, y1: 19.2, x2: 256, y2: 57.6 }],
          points: [],
        }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("./store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({
      ...settings,
      endpoints: {
        ...settings.endpoints,
        grounding: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "grounder", apiKey: "" },
      },
    });
    const uploadPath = path.join(root, "upload.png");
    await fs.writeFile(uploadPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8XcAAAAASUVORK5CYII=", "base64"));
    const upload = {
      fieldname: "files",
      originalname: "screen.png",
      encoding: "7bit",
      mimetype: "image/png",
      destination: root,
      filename: "upload.png",
      path: uploadPath,
      size: 68,
      buffer: Buffer.alloc(0),
      stream: undefined,
    } as unknown as Express.Multer.File;
    const created = await store.createGroundingJob([upload], ["SparklingKit"]);
    const processor = await import("./processor.js");
    await processor.processRun(created.id, created.runs[0].id);

    const completed = await store.readJob(created.id);
    expect(requestUrl).toBe("/predict-upload");
    expect(requestBody).toContain("ground_text");
    expect(requestBody).toContain("SparklingKit");
    expect(completed.status).toBe("done");
    expect(completed.moduleId).toBe("grounding");
    expect(completed.outputFiles).toEqual(["grounding-preview.svg", "grounding.annotations.json"]);
    expect(completed.artifacts.map((artifact) => artifact.kind)).toEqual(["source-image", "grounded-image", "annotations"]);
    const preview = await fs.readFile(path.join(store.jobDir(created.id), "output", "grounding-preview.svg"), "utf8");
    expect(preview).toContain("<rect");
    expect(preview).toContain("SparklingKit");
    const annotations = JSON.parse(await fs.readFile(path.join(store.jobDir(created.id), "output", "grounding.annotations.json"), "utf8"));
    expect(annotations.queries[0].boxes[0]).toEqual({ x1: 19.2, y1: 19.2, x2: 256, y2: 57.6 });
  });

  it("routes a generated image into grounding without uploading it again", async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          answer: "<ref>cat</ref><box><100><100><800><800></box>",
          image_width: 1024,
          image_height: 1024,
          boxes: [{ x1: 102.4, y1: 102.4, x2: 819.2, y2: 819.2 }],
          points: [],
        }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("./store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({
      ...settings,
      endpoints: {
        ...settings.endpoints,
        grounding: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "grounder", apiKey: "" },
      },
    });
    const created = await store.createTextToImageJob("A cat on a book");
    await fs.writeFile(store.safeOutputPath(created.id, "generated-image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8XcAAAAASUVORK5CYII=", "base64"));
    const generatedJob = await store.updateJob(created.id, { status: "done", progress: 100, stage: "Complete", outputFiles: ["generated-image.png"] });
    const generated = generatedJob.artifacts.find((artifact) => artifact.kind === "generated-image")!;
    const routed = await store.createWorkflowRun(created.id, "grounding", "grounding.image", { artifactId: generated.id, queries: ["cat"] }, [generated.id]);

    const processor = await import("./processor.js");
    await processor.processRun(created.id, routed.run.id);

    const completed = await store.readJob(created.id);
    expect(completed.outputFiles).toEqual(["generated-image.png", "grounding-preview.svg", "grounding.annotations.json"]);
    const preview = completed.artifacts.find((artifact) => artifact.kind === "grounded-image")!;
    expect(preview.derivedFrom).toEqual([generated.id]);
    expect(await fs.readFile(store.safeOutputPath(created.id, "grounding-preview.svg"), "utf8")).toContain("cat");
  });

  it("creates a durable interactive mind map and Markdown outline with the LLM", async () => {
    let requestBody = "";
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = Buffer.concat(chunks).toString("utf8");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          title: "Local AI workspace",
          root: { label: "SparklingKit", note: "A file-oriented workspace", children: [
            { label: "Tools", children: [{ label: "OCR", children: [] }, { label: "Transcription", children: [] }] },
            { label: "Workflows", children: [] },
          ] },
        }) } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");

    const store = await import("./store.js");
    await store.initializeData();
    const settings = await store.readSettings();
    await store.writeSettings({ ...settings, endpoints: { ...settings.endpoints, llm: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "mind-map-model", apiKey: "", capabilities: ["text"] } } });
    const created = await store.createMindMapJob("Explain the SparklingKit workspace", { depth: 4, breadth: 5 });
    const processor = await import("./processor.js");
    await processor.processRun(created.id, created.runs[0].id);

    const completed = await store.readJob(created.id);
    expect(completed.status).toBe("done");
    expect(completed.moduleId).toBe("mindmap");
    expect(completed.outputFiles).toEqual(["mindmap.json", "mindmap-outline.md"]);
    expect(completed.artifacts.map((artifact) => artifact.kind)).toEqual(["text", "mindmap", "document"]);
    const mindmap = JSON.parse(await fs.readFile(store.safeOutputPath(created.id, "mindmap.json"), "utf8"));
    expect(mindmap).toMatchObject({ version: 1, title: "Local AI workspace", root: { id: "node-1", label: "SparklingKit" } });
    expect(await fs.readFile(store.safeOutputPath(created.id, "mindmap-outline.md"), "utf8")).toContain("**OCR**");
    expect(JSON.parse(requestBody)).toMatchObject({ model: "mind-map-model", response_format: { type: "json_object" } });
  });
});
