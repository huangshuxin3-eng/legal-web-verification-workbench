"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TASK_SCOPE_PRESETS } from "@/config/task-generator";
import { useAuth } from "./auth-provider";
import type { Project, Task } from "@/lib/database.types";
import {
  buildCandidates,
  isScopeReady,
  parseEntities,
  reclassifyCandidates,
  scopesFromPresets,
  type CandidateTask,
  type ScopeInput,
} from "@/lib/task-generator";
import { getProjectTasks } from "@/lib/task-repository";
import { captureRequest, CaptureClientError } from "@/lib/capture-client";
import { errorMessage, safeWebsite } from "@/lib/tasks";

const categories = ["基础信息", "司法风险", "行政监管", "知识产权", "其他"];

export function TaskGenerator({ projectId }: { projectId: string }) {
  const { db } = useAuth();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [existing, setExisting] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [entityText, setEntityText] = useState("");
  const parsed = useMemo(() => parseEntities(entityText), [entityText]);
  const [scopes, setScopes] = useState<ScopeInput[]>(() =>
    scopesFromPresets(TASK_SCOPE_PRESETS),
  );
  const [selected, setSelected] = useState(
    () =>
      new Set(
        TASK_SCOPE_PRESETS.filter((scope) => scope.defaultSelected).map(
          (scope) => scope.id,
        ),
      ),
  );
  const [addingTemporary, setAddingTemporary] = useState(false);
  const [candidates, setCandidates] = useState<CandidateTask[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitLock = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [projectResult, tasks] = await Promise.all([
        db.from("projects").select("*").eq("id", projectId).single(),
        getProjectTasks(db, projectId),
      ]);
      if (projectResult.error) throw projectResult.error;
      setProject(projectResult.data);
      setExisting(tasks);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [db, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedScopes = scopes.filter((scope) => selected.has(scope.id));
  const invalidScopes = selectedScopes.filter((scope) => !isScopeReady(scope));
  const expectedCount = parsed.entities.length * selectedScopes.length;
  const pending = candidates.filter(
    (candidate) => candidate.availability === "pending",
  );
  const found = candidates.length - pending.length;
  const invalidCandidates = pending.some(
    (candidate) => !safeWebsite(candidate.source_url),
  );

  function updateScope(id: string, patch: Partial<ScopeInput>) {
    setScopes((current) =>
      current.map((scope) =>
        scope.id === id ? { ...scope, ...patch } : scope,
      ),
    );
  }

  async function goPreview() {
    if (
      !parsed.entities.length ||
      !selectedScopes.length ||
      invalidScopes.length
    )
      return;
    setBusy(true);
    setError("");
    try {
      const latest = await getProjectTasks(db, projectId);
      setExisting(latest);
      setCandidates(
        buildCandidates(projectId, parsed.entities, selectedScopes, latest),
      );
      setStep(3);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function createBatch() {
    if (submitLock.current || !pending.length || invalidCandidates) return;
    submitLock.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await captureRequest(db, "/api/tasks/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          tasks: candidates.map(
            ({ key: _key, availability: _availability, ...task }) => task,
          ),
        }),
      });
      const result = (await response.json()) as {
        created: number;
        skipped: number;
      };
      router.push(
        `/projects/${projectId}?created=${result.created}&skipped=${result.skipped}`,
      );
    } catch (error) {
      setError(
        error instanceof CaptureClientError
          ? error.message
          : errorMessage(error),
      );
      submitLock.current = false;
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="p-12" role="status">
        正在加载批量任务生成器…
      </main>
    );
  if (!project)
    return (
      <main className="mx-auto max-w-5xl p-8">
        <p className="error" role="alert">
          {error || "项目不存在或无权访问。"}
        </p>
        <Link className="btn mt-4" href={`/projects/${projectId}`}>
          返回项目工作台
        </Link>
      </main>
    );

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <Link
        className="text-sm text-slate-500 hover:text-blue-700"
        href={`/projects/${projectId}`}
      >
        ← 返回 {project.name}
      </Link>
      <div className="mt-6">
        <p className="text-sm text-slate-500">{project.name}</p>
        <h1 className="mt-1 text-2xl font-semibold">批量生成核查任务</h1>
      </div>
      <ol className="my-7 grid grid-cols-3 gap-2 text-center text-sm">
        {["核查对象", "核查范围", "预览并创建"].map((label, index) => (
          <li
            key={label}
            className={`rounded-lg px-3 py-3 ${step === index + 1 ? "bg-blue-700 text-white" : "bg-slate-200 text-slate-600"}`}
          >
            {index + 1} {label}
          </li>
        ))}
      </ol>

      {error && (
        <p className="error mb-5" role="alert">
          {error}
        </p>
      )}

      {step === 1 && (
        <section className="panel p-6" aria-labelledby="step-one-title">
          <h2 id="step-one-title" className="text-lg font-semibold">
            添加核查对象
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            每行输入一个主体名称，可直接从 Excel、Word、微信等复制粘贴。
          </p>
          <label className="mt-5">
            主体名称
            <textarea
              rows={12}
              autoFocus
              value={entityText}
              onChange={(event) => setEntityText(event.target.value)}
              placeholder={
                "北京木锐机器人有限公司\n上海某某科技有限公司\n深圳某某投资有限公司"
              }
            />
          </label>
          <div className="mt-3 text-sm">
            <p>已识别 {parsed.entities.length} 个核查对象</p>
            {parsed.duplicateCount > 0 && (
              <p className="text-amber-700">
                已自动去除 {parsed.duplicateCount} 个重复项
              </p>
            )}
          </div>
          <div className="mt-6 flex justify-end">
            <button
              className="btn primary"
              disabled={!parsed.entities.length}
              onClick={() => setStep(2)}
            >
              下一步：核查范围
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <div className="grid gap-6 lg:grid-cols-[1fr_250px]">
          <section className="panel p-6" aria-labelledby="step-two-title">
            <h2 id="step-two-title" className="text-lg font-semibold">
              核查事项 × 核查网站
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              未预填的网址需在继续前补充。系统不会从历史 Task 自动填写网址。
            </p>
            {categories.map((category) => {
              const rows = scopes.filter(
                (scope) => scope.category === category,
              );
              if (!rows.length) return null;
              return (
                <fieldset key={category} className="mt-6">
                  <legend className="font-semibold">{category}</legend>
                  <div className="mt-2 space-y-3">
                    {rows.map((scope) => (
                      <div
                        key={scope.id}
                        className="rounded-lg border border-slate-200 p-4"
                      >
                        <label className="flex items-start gap-3">
                          <input
                            className="mt-1 h-4 w-4 shrink-0"
                            type="checkbox"
                            checked={selected.has(scope.id)}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(scope.id);
                                else next.delete(scope.id);
                                return next;
                              })
                            }
                          />
                          <span>
                            <b>{scope.topic}</b>
                            <span className="mt-1 block text-xs font-normal text-slate-500">
                              {scope.sourceName}
                            </span>
                          </span>
                        </label>
                        {selected.has(scope.id) && (
                          <label className="mt-3 text-xs">
                            网站 URL *
                            <input
                              type="url"
                              placeholder="https://"
                              value={scope.sourceUrl}
                              onChange={(event) =>
                                updateScope(scope.id, {
                                  sourceUrl: event.target.value,
                                })
                              }
                            />
                            {!scope.sourceUrl.trim() && (
                              <span className="block text-xs font-normal text-amber-700">
                                需补充网站 URL
                              </span>
                            )}
                          </label>
                        )}
                      </div>
                    ))}
                  </div>
                </fieldset>
              );
            })}

            <button
              className="btn mt-6"
              onClick={() => setAddingTemporary((value) => !value)}
            >
              ＋ 添加临时核查网站
            </button>
            {addingTemporary && (
              <form
                className="mt-4 grid gap-3 rounded-lg bg-slate-50 p-4 md:grid-cols-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const topic = String(form.get("topic") ?? "").trim();
                  const sourceName = String(
                    form.get("source_name") ?? "",
                  ).trim();
                  const sourceUrl = String(form.get("source_url") ?? "").trim();
                  if (!topic || !sourceName || !safeWebsite(sourceUrl)) {
                    setError(
                      "临时核查网站的事项、名称和 HTTP(S) URL 均须有效。",
                    );
                    return;
                  }
                  const id = crypto.randomUUID();
                  setScopes((current) => [
                    ...current,
                    { id, category: "临时网站", topic, sourceName, sourceUrl },
                  ]);
                  setSelected((current) => new Set(current).add(id));
                  setAddingTemporary(false);
                  setError("");
                }}
              >
                <label>
                  核查事项 *<input name="topic" required />
                </label>
                <label>
                  网站名称 *<input name="source_name" required />
                </label>
                <label>
                  网站 URL *
                  <input name="source_url" type="url" required />
                </label>
                <div className="flex gap-2 md:col-span-3">
                  <button className="btn primary">添加到本次任务</button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setAddingTemporary(false)}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}
            {scopes
              .filter((scope) => scope.category === "临时网站")
              .map((scope) => (
                <div
                  key={scope.id}
                  className="mt-3 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm"
                >
                  <span>
                    {scope.topic} → {scope.sourceName} · {scope.sourceUrl}
                  </span>
                  <button
                    className="ml-3 text-red-700"
                    onClick={() => {
                      setScopes((current) =>
                        current.filter((item) => item.id !== scope.id),
                      );
                      setSelected((current) => {
                        const next = new Set(current);
                        next.delete(scope.id);
                        return next;
                      });
                    }}
                  >
                    移除
                  </button>
                </div>
              ))}
            {invalidScopes.length > 0 && (
              <p className="mt-4 text-sm text-amber-700">
                还有 {invalidScopes.length} 个已选范围缺少有效 URL。
              </p>
            )}
            <div className="mt-7 flex justify-between gap-3">
              <button className="btn" onClick={() => setStep(1)}>
                上一步
              </button>
              <button
                className="btn primary"
                onClick={() => void goPreview()}
                disabled={
                  busy || !selectedScopes.length || invalidScopes.length > 0
                }
              >
                {busy
                  ? "正在读取最新任务…"
                  : `下一步：预览 ${expectedCount} 个候选任务`}
              </button>
            </div>
          </section>
          <aside className="panel h-fit p-5 lg:sticky lg:top-6">
            <h2 className="font-semibold">本次任务</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt>核查对象</dt>
                <dd>{parsed.entities.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt>核查范围</dt>
                <dd>{selectedScopes.length}</dd>
              </div>
              <div className="flex justify-between border-t pt-3 font-semibold">
                <dt>预计生成 Task</dt>
                <dd>{expectedCount}</dd>
              </div>
            </dl>
          </aside>
        </div>
      )}

      {step === 3 && (
        <section aria-labelledby="step-three-title">
          <div className="panel flex flex-wrap gap-8 p-5 text-sm">
            <span>
              候选任务 <b className="ml-2 text-lg">{candidates.length}</b>
            </span>
            <span>
              待创建{" "}
              <b className="ml-2 text-lg text-blue-700">{pending.length}</b>
            </span>
            <span>
              已存在 <b className="ml-2 text-lg text-slate-500">{found}</b>
            </span>
          </div>
          <div className="panel mt-5 overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th>核查对象</th>
                  <th>核查事项</th>
                  <th>核查网站</th>
                  <th>网站 URL</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {candidates.map((candidate) => (
                  <tr
                    key={candidate.key}
                    className={
                      candidate.availability === "existing"
                        ? "bg-slate-100 text-slate-400"
                        : ""
                    }
                  >
                    <td>{candidate.entity_name}</td>
                    <td>{candidate.topic}</td>
                    <td>{candidate.source_name}</td>
                    <td className="min-w-64">
                      {candidate.availability === "existing" ? (
                        candidate.source_url
                      ) : (
                        <input
                          aria-label={`${candidate.entity_name} ${candidate.topic} 网站 URL`}
                          type="url"
                          value={candidate.source_url}
                          onChange={(event) => {
                            const changed = candidates.map((item) =>
                              item.key === candidate.key
                                ? { ...item, source_url: event.target.value }
                                : item,
                            );
                            setCandidates(
                              reclassifyCandidates(
                                projectId,
                                changed,
                                existing,
                              ),
                            );
                          }}
                        />
                      )}
                    </td>
                    <td>
                      {candidate.availability === "existing"
                        ? "已存在"
                        : "待创建"}
                    </td>
                    <td>
                      {candidate.availability === "pending" ? (
                        <button
                          className="text-red-700"
                          onClick={() =>
                            setCandidates((current) =>
                              current.filter(
                                (item) => item.key !== candidate.key,
                              ),
                            )
                          }
                        >
                          删除
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!candidates.length && (
              <p className="p-10 text-center text-sm text-slate-500">
                候选任务已全部删除。
              </p>
            )}
          </div>
          {invalidCandidates && (
            <p className="error mt-4">请修正待创建任务中的无效 HTTP(S) URL。</p>
          )}
          <div className="mt-6 flex justify-between gap-3">
            <button className="btn" disabled={busy} onClick={() => setStep(2)}>
              上一步
            </button>
            <button
              className="btn primary"
              disabled={busy || !pending.length || invalidCandidates}
              onClick={() => void createBatch()}
            >
              {busy ? "创建中…" : `创建 ${pending.length} 个核查任务`}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
