export function hostname(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLocaleLowerCase() || null;
  } catch {
    return null;
  }
}

export function taskMatchesSearch(task, search) {
  const keyword = search.trim().toLocaleLowerCase();
  if (!keyword) return true;
  return [task.entity_name, task.topic, task.source_name].some((value) =>
    String(value || "")
      .toLocaleLowerCase()
      .includes(keyword),
  );
}

export function groupTasksForPicker(tasks, currentUrl, search = "") {
  const currentHostname = hostname(currentUrl);
  const filtered = tasks.filter((task) => taskMatchesSearch(task, search));
  const matches = currentHostname
    ? filtered.filter((task) => hostname(task.source_url) === currentHostname)
    : [];
  const matchedIds = new Set(matches.map((task) => task.id));
  return {
    matches,
    others: filtered.filter((task) => !matchedIds.has(task.id)),
  };
}

export function validSelectedTaskId(tasks, selectedTaskId) {
  return tasks.some((task) => task.id === selectedTaskId) ? selectedTaskId : "";
}
