import { TASK_SCOPE_PRESETS } from "../config/task-generator.ts";

export type OrderableTask = {
  id: string;
  entity_name: string;
  topic: string;
  created_at: string;
};

export const CANONICAL_TOPIC_ORDER = TASK_SCOPE_PRESETS.map(
  (preset) => preset.topic,
);

const topicRanks = new Map(
  CANONICAL_TOPIC_ORDER.map((topic, index) => [topic, index]),
);
const entityCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "variant",
});

function compareCreated(left: OrderableTask, right: OrderableTask) {
  return (
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  );
}

export function compareTasksCanonical(
  left: OrderableTask,
  right: OrderableTask,
) {
  const byEntity = entityCollator.compare(left.entity_name, right.entity_name);
  if (byEntity) return byEntity;

  const leftRank = topicRanks.get(left.topic);
  const rightRank = topicRanks.get(right.topic);
  if (leftRank !== undefined || rightRank !== undefined) {
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }

  return compareCreated(left, right);
}

export function sortTasksCanonical<T extends OrderableTask>(
  tasks: readonly T[],
) {
  return tasks.toSorted(compareTasksCanonical);
}

export function taskSequenceMap(tasks: readonly OrderableTask[]) {
  return new Map(
    sortTasksCanonical(tasks).map((task, index) => [task.id, index + 1]),
  );
}
