import type { ModuleId, SearchResponse, SearchResult, SearchScope } from "./models.js";
import { listModules } from "./modules/registry.js";
import { listChats, listJobs, readSettings } from "./store.js";

type RankedResult = SearchResult & { score: number };

function normalized(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function matchScore(query: string, primary: string, secondary: string[] = []) {
  if (!query) return 1;
  const title = normalized(primary);
  const supporting = secondary.map(normalized);
  const haystack = [title, ...supporting].join(" ");
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => haystack.includes(term))) return 0;
  if (title === query) return 120;
  if (title.startsWith(query)) return 100;
  if (title.includes(query)) return 80;
  if (terms.every((term) => title.includes(term))) return 70;
  return 50;
}

function recentFirst(left: RankedResult, right: RankedResult) {
  return right.score - left.score || (right.updatedAt || "").localeCompare(left.updatedAt || "") || left.title.localeCompare(right.title);
}

function belongsToModule(job: Awaited<ReturnType<typeof listJobs>>[number], moduleId?: ModuleId) {
  return !moduleId || job.moduleId === moduleId || job.runs.some((run) => run.moduleId === moduleId);
}

export async function searchWorkspace(
  rawQuery: string,
  options: { scope?: SearchScope; moduleId?: ModuleId; limit?: number } = {},
): Promise<SearchResponse> {
  const query = normalized(rawQuery).slice(0, 200);
  const scope = options.scope || "all";
  const limit = Math.max(1, Math.min(options.limit || 30, 60));
  const includeWork = scope === "all" || scope === "work";
  const includeChats = scope === "all" || scope === "chats";
  const includeTools = scope === "all" || scope === "tools";
  const [jobs, chats, settings] = await Promise.all([
    includeWork ? listJobs() : Promise.resolve([]),
    includeChats ? listChats() : Promise.resolve([]),
    includeTools || includeWork ? readSettings() : Promise.resolve(undefined),
  ]);
  const modules = settings ? listModules(settings) : [];
  const moduleNames = new Map(modules.map((module) => [module.id, module.title]));

  const work: RankedResult[] = [];
  if (includeWork) {
    for (const job of jobs.filter((candidate) => belongsToModule(candidate, options.moduleId))) {
      const moduleTitle = moduleNames.get(job.moduleId) || job.moduleId;
      const score = matchScore(query, job.title, [moduleTitle, job.stage, job.status]);
      if (score) work.push({
        id: `job:${job.id}`,
        type: "job",
        group: "work",
        title: job.title,
        subtitle: `${moduleTitle} · ${job.stage}`,
        url: `/jobs/${encodeURIComponent(job.id)}`,
        updatedAt: job.updatedAt,
        moduleId: job.moduleId,
        score,
      });

      if (!query) continue;
      for (const artifact of job.artifacts) {
        const artifactScore = matchScore(query, artifact.name, [artifact.path, artifact.kind, job.title, moduleTitle]);
        if (!artifactScore) continue;
        work.push({
          id: `artifact:${job.id}:${artifact.id}`,
          type: "artifact",
          group: "work",
          title: artifact.name,
          subtitle: `${artifact.role === "source" ? "Source file" : "Generated output"} · ${job.title}`,
          url: `/jobs/${encodeURIComponent(job.id)}?artifact=${encodeURIComponent(artifact.id)}`,
          updatedAt: artifact.createdAt || job.updatedAt,
          moduleId: job.moduleId,
          artifactKind: artifact.kind,
          score: artifactScore + 5,
        });
      }
    }
  }

  const conversations: RankedResult[] = includeChats ? chats.flatMap((chat) => {
    const score = matchScore(query, chat.title, [chat.model]);
    return score ? [{
      id: `conversation:${chat.id}`,
      type: "conversation" as const,
      group: "conversations" as const,
      title: chat.title,
      subtitle: chat.model,
      url: `/chat/${encodeURIComponent(chat.id)}`,
      updatedAt: chat.updatedAt,
      score,
    }] : [];
  }) : [];

  const tools: RankedResult[] = includeTools ? modules.flatMap((module) => {
    const score = matchScore(query, module.title, [module.shortTitle, module.description]);
    return score ? [{
      id: `module:${module.id}`,
      type: "module" as const,
      group: "tools" as const,
      title: module.title,
      subtitle: module.description,
      url: module.route,
      moduleId: module.id,
      score,
    }] : [];
  }) : [];

  work.sort(recentFirst);
  conversations.sort(recentFirst);
  tools.sort(recentFirst);
  const ranked = scope === "all"
    ? [...work.slice(0, 16), ...conversations.slice(0, 8), ...tools.slice(0, 8)].slice(0, limit)
    : [...work, ...conversations, ...tools].sort(recentFirst).slice(0, limit);
  return {
    query: rawQuery.trim(),
    scope,
    total: work.length + conversations.length + tools.length,
    results: ranked.map(({ score: _score, ...result }) => result),
  };
}
