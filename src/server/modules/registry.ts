import { acceptedArtifactKinds, MODULE_CONTRACTS, nextModuleActions } from "../../shared/module-router.js";
import type { ModuleDescriptor, ModuleId, Settings } from "../models.js";

export function listModules(settings?: Settings): ModuleDescriptor[] {
  const modelInputs = settings?.endpoints.llm.capabilities || ["text"];
  return MODULE_CONTRACTS.map((contract) => ({
    id: contract.id,
    title: contract.title,
    shortTitle: contract.shortTitle,
    description: contract.description,
    icon: contract.icon,
    route: contract.route,
    providerKind: contract.providerKind,
    accepts: acceptedArtifactKinds(contract, modelInputs),
    produces: [...contract.produces],
    actions: nextModuleActions(contract, modelInputs).map((action) => ({ ...action, accepts: [...action.accepts] })),
    implementation: contract.implementation,
    configured: settings
      ? Boolean(settings.endpoints[contract.providerKind]?.enabled && settings.endpoints[contract.providerKind]?.baseUrl && settings.endpoints[contract.providerKind]?.model)
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
