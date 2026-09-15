import { TaskGenerator } from "@/components/task-generator";

export default async function GenerateTasksPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <TaskGenerator key={projectId} projectId={projectId} />;
}
