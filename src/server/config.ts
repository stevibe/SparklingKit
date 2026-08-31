import path from "node:path";
import type { PromptPreset, Settings } from "./models.js";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, "data"));
export const CLIENT_DIR = path.resolve(ROOT_DIR, "dist-client");
export const PORT = Number(process.env.PORT || 8787);
export const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

export const defaultSettings: Settings = {
  schemaVersion: 2,
  endpoints: {
    llm: {
      baseUrl: process.env.LLM_BASE_URL || "http://192.0.2.10:8330/v1",
      model: process.env.LLM_MODEL || "qwen36-35b-a3b-nvfp4",
      apiKey: process.env.LLM_API_KEY || "",
      enabled: true,
    },
    ocr: {
      baseUrl: process.env.OCR_BASE_URL || "http://192.0.2.10:8331/v1",
      model: process.env.OCR_MODEL || "Unlimited-OCR",
      apiKey: process.env.OCR_API_KEY || "",
      enabled: true,
    },
    stt: {
      baseUrl: process.env.STT_BASE_URL || "http://192.0.2.10:8332/v1",
      model: process.env.STT_MODEL || "Qwen3-ASR-1.7B",
      apiKey: process.env.STT_API_KEY || "",
      enabled: true,
    },
    translation: {
      baseUrl: process.env.TRANSLATION_BASE_URL || "http://192.0.2.10:8333/v1",
      model: process.env.TRANSLATION_MODEL || "Hy-MT2-1.8B-FP8",
      apiKey: process.env.TRANSLATION_API_KEY || "",
      enabled: true,
    },
    grounding: {
      baseUrl: process.env.GROUNDING_BASE_URL || "http://192.0.2.10:8334/v1",
      model: process.env.GROUNDING_MODEL || "nvidia/LocateAnything-3B",
      apiKey: process.env.GROUNDING_API_KEY || "",
      enabled: true,
    },
    "image-generation": {
      baseUrl: process.env.IMAGE_GENERATION_BASE_URL || "http://192.0.2.10:8335/v1",
      model: process.env.IMAGE_GENERATION_MODEL || "Z-Image-Turbo",
      apiKey: process.env.IMAGE_GENERATION_API_KEY || "",
      enabled: true,
    },
  },
  audio: {
    chunkTargetSec: 60,
    chunkOverlapSec: 3,
    sampleRate: 16000,
    maxCompletionTokens: 2048,
    requestTimeoutSec: 180,
    adaptiveSplit: true,
    minAdaptiveChunkSec: 15,
  },
  pdf: { dpi: 175, pagesPerBatch: 20 },
  queue: { workers: 2, maxRetriesPerChunk: 2 },
  retention: { purgeWorkDirAfterDays: 7 },
  ui: { language: "en", theme: "auto", timezone: "UTC" },
};

export const defaultPrompts: PromptPreset[] = [
  {
    name: "Meeting minutes",
    slug: "meeting-minutes",
    description: "Decisions, discussion highlights, and accountable action items.",
    system: "You are a precise minute-taker. Preserve facts and names. Never invent missing details.",
    userTemplate:
      "Create concise meeting minutes from the source below. Include: overview, key points, decisions, and action items with owners when stated.\n\n{{text}}",
    params: { temperature: 0.2, maxTokens: 4096 },
    chunking: { maxInputTokens: 24000, strategy: "map-reduce" },
  },
  {
    name: "Clean document",
    slug: "clean-document",
    description: "Repair OCR errors and restore readable Markdown structure.",
    system: "You are an expert document editor. Preserve meaning and do not add facts.",
    userTemplate:
      "Clean the following extracted text. Fix obvious OCR errors, restore headings and lists, and return only Markdown.\n\n{{text}}",
    params: { temperature: 0.1, maxTokens: 8192 },
    chunking: { maxInputTokens: 24000, strategy: "map-reduce" },
  },
  {
    name: "Executive summary",
    slug: "executive-summary",
    description: "A short, decision-oriented summary of any source.",
    system: "You write accurate, economical executive briefings.",
    userTemplate:
      "Summarize this source for a busy decision-maker. Cover context, important findings, risks, and next steps.\n\n{{text}}",
    params: { temperature: 0.25, maxTokens: 3072 },
    chunking: { maxInputTokens: 24000, strategy: "map-reduce" },
  },
];
