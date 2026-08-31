import type { ModuleDescriptor, ModuleId, Settings } from "../models.js";

const textKinds = ["document", "transcript", "translation", "redacted-document", "text"] as const;

const definitions: ModuleDescriptor[] = [
  {
    id: "ocr",
    title: "OCR",
    shortTitle: "OCR",
    description: "Turn images and scanned documents into structured, searchable text.",
    icon: "scan-text",
    route: "/tools/ocr",
    providerKind: "ocr",
    accepts: ["source-image", "source-pdf"],
    produces: ["document", "structured-data"],
    actions: [
      { id: "summarize", label: "Summarize", accepts: [...textKinds] },
      { id: "translate", label: "Translate", accepts: [...textKinds] },
      { id: "ground", label: "Find and highlight", accepts: [...textKinds] },
      { id: "chat", label: "Ask in chat", accepts: [...textKinds] },
    ],
    implementation: "ready",
  },
  {
    id: "transcription",
    title: "Transcription",
    shortTitle: "Transcribe",
    description: "Convert recordings into readable transcripts and subtitles.",
    icon: "audio-lines",
    route: "/tools/transcription",
    providerKind: "stt",
    accepts: ["source-audio", "source-video"],
    produces: ["transcript", "subtitle", "structured-data"],
    actions: [
      { id: "summarize", label: "Summarize", accepts: [...textKinds] },
      { id: "translate", label: "Translate", accepts: [...textKinds] },
      { id: "ground", label: "Find and highlight", accepts: [...textKinds] },
      { id: "chat", label: "Ask in chat", accepts: [...textKinds] },
    ],
    implementation: "ready",
  },
  {
    id: "translation",
    title: "Translation",
    shortTitle: "Translate",
    description: "Translate existing documents and transcripts with a dedicated language model.",
    icon: "languages",
    route: "/tools/translation",
    providerKind: "translation",
    accepts: [...textKinds],
    produces: ["translation"],
    actions: [
      { id: "summarize", label: "Summarize", accepts: [...textKinds] },
      { id: "ground", label: "Find and highlight", accepts: [...textKinds] },
      { id: "chat", label: "Ask in chat", accepts: [...textKinds] },
    ],
    implementation: "ready",
  },
  {
    id: "grounding",
    title: "Grounding",
    shortTitle: "Ground",
    description: "Find evidence, highlight matches, and prepare sensitive information for redaction.",
    icon: "scan-search",
    route: "/tools/grounding",
    providerKind: "grounding",
    accepts: ["source-image"],
    produces: ["grounded-image", "annotations"],
    actions: [],
    implementation: "ready",
  },
  {
    id: "text-to-image",
    title: "Text to image",
    shortTitle: "Generate",
    description: "Create an image from a written description with a dedicated image model.",
    icon: "image",
    route: "/tools/text-to-image",
    providerKind: "image-generation",
    accepts: ["text"],
    produces: ["generated-image"],
    actions: [],
    implementation: "ready",
  },
  {
    id: "chat",
    title: "Chat",
    shortTitle: "Chat",
    description: "Explore documents, transcripts, and ideas in a focused conversation.",
    icon: "message-circle",
    route: "/chat",
    providerKind: "llm",
    accepts: [...textKinds, "annotations", "structured-data"],
    produces: ["text"],
    actions: [],
    implementation: "ready",
  },
];

export function listModules(settings?: Settings): ModuleDescriptor[] {
  return definitions.map((definition) => ({
    ...definition,
    actions: definition.actions.map((action) => ({ ...action, accepts: [...action.accepts] })),
    accepts: [...definition.accepts],
    produces: [...definition.produces],
    configured: settings
      ? Boolean(settings.endpoints[definition.providerKind]?.enabled && settings.endpoints[definition.providerKind]?.baseUrl && settings.endpoints[definition.providerKind]?.model)
      : undefined,
  }));
}

export function getModule(id: ModuleId, settings?: Settings) {
  return listModules(settings).find((definition) => definition.id === id);
}

export function moduleForLegacyJob(type: "audio" | "image" | "pdf" | "text") {
  return type === "audio"
    ? { moduleId: "transcription" as const, workflowId: "transcription.default" }
    : type === "text"
      ? { moduleId: "text-to-image" as const, workflowId: "text-to-image.default" }
    : { moduleId: "ocr" as const, workflowId: type === "pdf" ? "ocr.pdf" : "ocr.images" };
}
