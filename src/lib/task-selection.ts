export function toggleTaskSelection(
  selected: ReadonlySet<string>,
  taskId: string,
  checked: boolean,
) {
  const next = new Set(selected);
  if (checked) next.add(taskId);
  else next.delete(taskId);
  return next;
}

export function selectVisibleTasks(
  visibleTaskIds: readonly string[],
  checked: boolean,
) {
  return checked ? new Set(visibleTaskIds) : new Set<string>();
}

export function retainVisibleSelection(
  selected: ReadonlySet<string>,
  visibleTaskIds: readonly string[],
) {
  const visible = new Set(visibleTaskIds);
  return new Set([...selected].filter((taskId) => visible.has(taskId)));
}
