begin;

-- V1 closing loop: AI 分析草稿（生成 → 保存 → 人工编辑 → 人工确认 → 最终 DOCX 使用）
-- 挂在项目行上。只加一个可空 jsonb 列，不建表、不建 policy、不建 trigger ——
-- 既有 `projects_owner`（for all to authenticated）策略已经把每一行读写限定在 owner。

alter table public.projects add column analysis_draft jsonb;

-- 只做**形状**守卫（廉价、不含业务逻辑）：要么 null，要么是一个携带 version 与
-- sections 的对象。内容级校验（四段非空字符串、服务端拥有的时间戳、sourceHash 比对）
-- 一律留在服务端代码里，SQL 不复制业务规则。
alter table public.projects add constraint projects_analysis_draft_shape check (
  analysis_draft is null
  or (
    jsonb_typeof(analysis_draft) = 'object'
    and analysis_draft ? 'version'
    and analysis_draft ? 'sections'
  )
);

commit;
