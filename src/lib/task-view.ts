export const TASK_PAGE_SIZES = [25, 50, 100] as const;
export type TaskPageSize = (typeof TASK_PAGE_SIZES)[number];

export type FilterableTask = {
  status: string;
  entity_name: string;
  topic: string;
  source_name: string;
};

export type TaskFilters = {
  search: string;
  status: string;
  entity: string;
  topic: string;
};

export function filterTasks<T extends FilterableTask>(
  tasks: readonly T[],
  filters: TaskFilters,
) {
  const search = filters.search.trim().toLocaleLowerCase();
  return tasks.filter(
    (task) =>
      (!filters.status || task.status === filters.status) &&
      (!filters.entity || task.entity_name === filters.entity) &&
      (!filters.topic || task.topic === filters.topic) &&
      (!search ||
        [task.entity_name, task.topic, task.source_name].some((value) =>
          value.toLocaleLowerCase().includes(search),
        )),
  );
}

export function clampTaskPage(
  page: number,
  totalItems: number,
  pageSize: number,
) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return Math.min(Math.max(1, page), totalPages);
}

export function paginateTasks<T>(
  tasks: readonly T[],
  requestedPage: number,
  pageSize: number,
) {
  const page = clampTaskPage(requestedPage, tasks.length, pageSize);
  const totalPages = Math.max(1, Math.ceil(tasks.length / pageSize));
  const offset = (page - 1) * pageSize;
  const items = tasks.slice(offset, offset + pageSize);
  return {
    page,
    totalPages,
    items,
    start: tasks.length ? offset + 1 : 0,
    end: offset + items.length,
  };
}
