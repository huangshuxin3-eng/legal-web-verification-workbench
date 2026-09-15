import { ProjectWorkspace } from "@/components/project-workspace";
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ created?: string; skipped?: string }>;
}) {
  const { projectId } = await params;
  const result = await searchParams;
  const created = Number(result.created ?? 0);
  const skipped = Number(result.skipped ?? 0);
  return (
    <ProjectWorkspace
      key={projectId}
      projectId={projectId}
      batchResult={{
        created: Number.isFinite(created) && created >= 0 ? created : 0,
        skipped: Number.isFinite(skipped) && skipped >= 0 ? skipped : 0,
      }}
    />
  );
}
