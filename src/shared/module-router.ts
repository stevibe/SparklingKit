import type { ArtifactKind, ModelInputCapability, ModuleDescriptor, ModuleId } from "./contracts.js";

export type ModuleHandoff =
  | { mode: "upload" }
  | { mode: "workflow"; workflows: ReadonlyArray<{ workflowId: string; accepts: readonly ArtifactKind[] }>; maxInputs: number }
  | { mode: "conversation" };

export interface ModuleContract extends Omit<ModuleDescriptor, "actions" | "configured"> {
  handoff: ModuleHandoff;
  actionLabel: string;
  actionDescription: string;
  allowSelfHandoff?: boolean;
}

const textResults: ArtifactKind[] = ["document", "transcript", "translation", "redacted-document", "text"];
const imageResults: ArtifactKind[] = ["source-image", "generated-image", "grounded-image"];

/**
 * The module graph's single source of truth.
 *
 * Adding a module here declares both sides of its contract: artifact kinds it
 * consumes and artifact kinds it produces. The UI and API both use this graph,
 * so a compatible handoff cannot be advertised without also being accepted by
 * the server.
 */
export const MODULE_CONTRACTS: readonly ModuleContract[] = [
  {
    id: "ocr",
    title: "OCR",
    shortTitle: "OCR",
    description: "Turn images and scanned documents into structured, searchable text.",
    icon: "scan-text",
    route: "/tools/ocr",
    providerKind: "ocr",
    accepts: ["source-image", "source-pdf", "generated-image", "grounded-image"],
    produces: ["document", "structured-data"],
    handoff: { mode: "workflow", workflows: [
      { workflowId: "ocr.images", accepts: imageResults },
      { workflowId: "ocr.pdf", accepts: ["source-pdf"] },
    ], maxInputs: 100 },
    actionLabel: "Read text",
    actionDescription: "Extract text from this image",
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
    handoff: { mode: "workflow", workflows: [{ workflowId: "transcription.default", accepts: ["source-audio", "source-video"] }], maxInputs: 100 },
    actionLabel: "Transcribe",
    actionDescription: "Turn this recording into text",
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
    accepts: textResults,
    produces: ["translation"],
    handoff: { mode: "workflow", workflows: [{ workflowId: "translation.default", accepts: textResults }], maxInputs: 1 },
    actionLabel: "Translate",
    actionDescription: "Translate this text into another language",
    allowSelfHandoff: true,
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
    accepts: imageResults,
    produces: ["grounded-image", "annotations"],
    handoff: { mode: "workflow", workflows: [{ workflowId: "grounding.image", accepts: imageResults }], maxInputs: 1 },
    actionLabel: "Find in image",
    actionDescription: "Locate and frame something in this image",
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
    accepts: textResults,
    produces: ["generated-image"],
    handoff: { mode: "workflow", workflows: [{ workflowId: "text-to-image.default", accepts: textResults }], maxInputs: 1 },
    actionLabel: "Create image",
    actionDescription: "Use this text as an editable image prompt",
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
    accepts: [...textResults, "annotations", "structured-data"],
    produces: ["text"],
    handoff: { mode: "conversation" },
    actionLabel: "Ask in chat",
    actionDescription: "Explore this result in a conversation",
    allowSelfHandoff: true,
    implementation: "ready",
  },
];

export function getModuleContract(moduleId: ModuleId) {
  return MODULE_CONTRACTS.find((contract) => contract.id === moduleId);
}

export function acceptedArtifactKinds(contract: ModuleContract, modelInputs: readonly ModelInputCapability[] = ["text"]) {
  if (contract.id !== "chat" || !modelInputs.includes("image")) return [...contract.accepts];
  return [...new Set<ArtifactKind>([...contract.accepts, ...imageResults])];
}

export function moduleAcceptsArtifact(moduleId: ModuleId, artifactKind: ArtifactKind, modelInputs?: readonly ModelInputCapability[]) {
  const contract = getModuleContract(moduleId);
  return Boolean(contract && acceptedArtifactKinds(contract, modelInputs).includes(artifactKind));
}

export function moduleWorkflowForArtifact(moduleId: ModuleId, artifactKind: ArtifactKind) {
  const contract = getModuleContract(moduleId);
  if (!contract || contract.handoff.mode !== "workflow") return undefined;
  return contract.handoff.workflows.find((workflow) => workflow.accepts.includes(artifactKind))?.workflowId;
}

export function compatibleModuleContracts(artifactKind: ArtifactKind, sourceModuleId?: ModuleId, modelInputs?: readonly ModelInputCapability[]) {
  return MODULE_CONTRACTS.filter((contract) =>
    contract.implementation === "ready"
    && contract.handoff.mode !== "upload"
    && acceptedArtifactKinds(contract, modelInputs).includes(artifactKind)
    && (contract.id !== sourceModuleId || contract.allowSelfHandoff),
  );
}

export function nextModuleActions(source: ModuleContract, modelInputs?: readonly ModelInputCapability[]) {
  const actions = new Map<ModuleId, { id: ModuleId; label: string; accepts: ArtifactKind[] }>();
  for (const outputKind of source.produces) {
    for (const destination of compatibleModuleContracts(outputKind, source.id, modelInputs)) {
      const action = actions.get(destination.id) || { id: destination.id, label: destination.actionLabel, accepts: [] };
      if (!action.accepts.includes(outputKind)) action.accepts.push(outputKind);
      actions.set(destination.id, action);
    }
  }
  return [...actions.values()];
}

export function moduleHandoffUrl(moduleId: ModuleId, jobId: string, artifactId: string) {
  const contract = getModuleContract(moduleId);
  if (!contract) return "/tools";
  const query = new URLSearchParams({ job: jobId, artifact: artifactId });
  return `${contract.route}?${query}`;
}
