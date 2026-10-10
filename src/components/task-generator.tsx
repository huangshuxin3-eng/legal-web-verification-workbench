"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "./dialog";
import { ProjectWorkspace } from "./project-workspace";
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
  const [, setAddingTemporary] = useState(false);
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
    <>
      <ProjectWorkspace projectId={projectId} />
      <Dialog
        title="批量创建核查任务"
        onClose={() => router.push(`/projects/${projectId}`)}
        busy={busy}
        wide
        footer={
          <div className="lt-footer-actions">
            {step === 3 ? (
              <>
                <button
                  className="btn lt-footer-back"
                  disabled={busy}
                  onClick={() => setStep(2)}
                >
                  上一步
                </button>
                <button
                  className="btn primary"
                  disabled={busy || !pending.length || invalidCandidates}
                  onClick={() => void createBatch()}
                >
                  {busy ? "创建中…" : `创建 ${pending.length} 个核查任务`}
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => router.push(`/projects/${projectId}`)}
                >
                  取消
                </button>
                <button
                  className="btn primary"
                  onClick={() => void goPreview()}
                  disabled={
                    busy ||
                    !parsed.entities.length ||
                    !selectedScopes.length ||
                    invalidScopes.length > 0
                  }
                >
                  {busy ? "正在读取最新任务…" : "预览并创建"}
                </button>
              </>
            )}
          </div>
        }
      >
        <div className="lt-batch-content">
          <div className="lt-step-strip">
            <span className={step !== 3 ? "current" : ""}>
              <b>01</b>
              {step === 3 ? "核查对象" : "添加核查对象"}
            </span>
            <span className={step !== 3 ? "current" : ""}>
              <b>02</b>
              {step === 3 ? "核查范围" : "选择核查范围"}
            </span>
            <span className={step === 3 ? "current" : ""}>
              <b>03</b>预览并创建
            </span>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {step !== 3 ? (
            <>
              <label className="lt-field">
                添加核查对象
                <textarea
                  rows={3}
                  autoFocus
                  value={entityText}
                  onChange={(event) => setEntityText(event.target.value)}
                  placeholder="每行一个对象名称，重复名称将自动去重。"
                />
              </label>
              {parsed.duplicateCount > 0 && (
                <p className="lt-batch-note">
                  已自动去除 {parsed.duplicateCount} 个重复项
                </p>
              )}
              <div className="lt-scope-heading">
                <h3>核查事项与数据来源</h3>
                <span>勾选需要加入的核查网站</span>
              </div>
              <div className="lt-scopes">
                {scopes
                  .filter((scope) => scope.category !== "临时网站")
                  .map((scope) => (
                    <div
                      key={scope.id}
                      className={`lt-scope ${selected.has(scope.id) ? "is-selected" : ""}`}
                    >
                      <label className="lt-scope-label">
                        <input
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
                        <strong>{scope.topic}</strong>
                        <small>{scope.sourceName}</small>
                      </label>
                      {TASK_SCOPE_PRESETS.find(
                        (preset) => preset.id === scope.id,
                      )?.sourceUrl ? (
                        <textarea
                          className="lt-preset-url"
                          rows={scope.sourceUrl.length > 55 ? 2 : 1}
                          aria-label={`${scope.topic} 网站 URL`}
                          value={scope.sourceUrl}
                          onChange={(event) =>
                            updateScope(scope.id, {
                              sourceUrl: event.target.value,
                            })
                          }
                        />
                      ) : (
                        <input
                          className="lt-scope-url"
                          type="url"
                          aria-label={`${scope.topic} 网站 URL`}
                          placeholder="请补充网站 URL"
                          value={scope.sourceUrl}
                          onChange={(event) =>
                            updateScope(scope.id, {
                              sourceUrl: event.target.value,
                            })
                          }
                        />
                      )}
                    </div>
                  ))}
              </div>
              <div className="lt-scope-heading">
                <h3>自定义网站</h3>
                <span>仅用于本次批量创建</span>
              </div>
              <form
                className="lt-custom-fields"
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
                      "临时数据来源的事项、名称和 HTTP(S) URL 均须有效。",
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
                  核查事项
                  <input name="topic" required placeholder="例如：专项核查" />
                </label>
                <label>
                  数据来源
                  <input name="source_name" required placeholder="网站名称" />
                </label>
                <label>
                  网站地址
                  <input
                    name="source_url"
                    type="url"
                    required
                    placeholder="https://"
                  />
                </label>
                <button className="btn lt-compact-btn">添加</button>
              </form>
              {scopes
                .filter((scope) => scope.category === "临时网站")
                .map((scope) => (
                  <div key={scope.id} className="lt-summary-line">
                    <span>
                      {scope.topic} · {scope.sourceName} · {scope.sourceUrl}
                    </span>
                    <button
                      className="lt-link-btn danger"
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
                <p className="lt-batch-note">
                  还有 {invalidScopes.length} 个已选范围缺少有效 URL。
                </p>
              )}
            </>
          ) : (
            <>
              <div className="lt-summary-line">
                <span>共 {pending.length} 项待创建任务</span>
                <span>创建前请核对对象、事项与网站 · 已存在 {found} 项</span>
              </div>
              <div className="lt-task-table-scroll">
                <table className="lt-task-table lt-candidate-table">
                  <thead>
                    <tr>
                      <th>核查对象</th>
                      <th>核查事项</th>
                      <th>数据来源</th>
                      <th>网站</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((candidate) => (
                      <tr
                        key={candidate.key}
                        className={
                          candidate.availability === "existing"
                            ? "lt-existing-row"
                            : ""
                        }
                      >
                        <td>{candidate.entity_name}</td>
                        <td>{candidate.topic}</td>
                        <td>{candidate.source_name}</td>
                        <td>
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
                                    ? {
                                        ...item,
                                        source_url: event.target.value,
                                      }
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
                              className="lt-link-btn danger"
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
                  <p className="lt-empty">候选任务已全部删除。</p>
                )}
              </div>
              {invalidCandidates && (
                <p className="error">请修正待创建任务中的无效 HTTP(S) URL。</p>
              )}
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
