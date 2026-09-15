import type { Task } from "./database.types";
import type { TaskCreateInput } from "./task-repository";

export type ScopeInput = {
  id: string;
  category: string;
  topic: string;
  sourceName: string;
  sourceUrl: string;
};
export type CandidateTask = TaskCreateInput & {
  key: string;
  availability: "pending" | "existing";
};
type ScopePresetInput = Omit<ScopeInput, "sourceUrl"> & {
  sourceUrl: string | null;
};

export function scopesFromPresets(
  presets: readonly ScopePresetInput[],
): ScopeInput[] {
  return presets.map((scope) => ({
    ...scope,
    sourceUrl: scope.sourceUrl ?? "",
  }));
}

export function isScopeReady(scope: ScopeInput) {
  if (!scope.topic.trim() || !scope.sourceName.trim()) return false;
  try {
    return ["http:", "https:"].includes(
      new URL(scope.sourceUrl.trim()).protocol,
    );
  } catch {
    return false;
  }
}

export function parseEntities(value: string) {
  const seen = new Set<string>();
  const entities: string[] = [];
  let duplicateCount = 0;
  for (const line of value.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    if (seen.has(name)) duplicateCount += 1;
    else {
      seen.add(name);
      entities.push(name);
    }
  }
  return { entities, duplicateCount };
}

export function taskIdentity(
  projectId: string,
  task: Pick<
    TaskCreateInput,
    "entity_name" | "topic" | "source_name" | "source_url"
  >,
) {
  const normalized = canonicalTaskFields(task);
  return JSON.stringify([
    projectId,
    normalized.entity_name,
    normalized.topic,
    normalized.source_name,
    normalized.source_url,
  ]);
}

export function canonicalTaskFields<
  T extends Pick<
    TaskCreateInput,
    "entity_name" | "topic" | "source_name" | "source_url"
  >,
>(task: T): T {
  return {
    ...task,
    entity_name: task.entity_name.trim(),
    topic: task.topic.trim(),
    source_name: task.source_name.trim(),
    source_url: task.source_url.trim(),
  };
}

export function buildCandidates(
  projectId: string,
  entities: readonly string[],
  scopes: readonly ScopeInput[],
  existing: readonly Pick<
    Task,
    "project_id" | "entity_name" | "topic" | "source_name" | "source_url"
  >[],
) {
  const existingKeys = new Set(
    existing.map((task) => taskIdentity(task.project_id, task)),
  );
  const batchKeys = new Set<string>();
  const result: CandidateTask[] = [];
  for (const entity_name of entities) {
    for (const scope of scopes) {
      const input = canonicalTaskFields<TaskCreateInput>({
        entity_name,
        topic: scope.topic,
        source_name: scope.sourceName,
        source_url: scope.sourceUrl,
        note: null,
        status: "not_started",
      });
      const key = taskIdentity(projectId, input);
      if (batchKeys.has(key)) continue;
      batchKeys.add(key);
      result.push({
        ...input,
        key,
        availability: existingKeys.has(key) ? "existing" : "pending",
      });
    }
  }
  return result;
}

export function reclassifyCandidates(
  projectId: string,
  candidates: readonly CandidateTask[],
  existing: readonly Pick<
    Task,
    "project_id" | "entity_name" | "topic" | "source_name" | "source_url"
  >[],
) {
  const existingKeys = new Set(
    existing.map((task) => taskIdentity(task.project_id, task)),
  );
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const normalized = canonicalTaskFields(candidate);
    const key = taskIdentity(projectId, normalized);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        ...normalized,
        key,
        availability: existingKeys.has(key) ? "existing" : "pending",
      } as CandidateTask,
    ];
  });
}
