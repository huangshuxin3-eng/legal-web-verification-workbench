import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("批量创建在原路由使用宽 Modal，范围为三列卡片且保留真实提交", async () => {
  const [generator, css] = await Promise.all([
    source("components/task-generator.tsx"),
    source("app/globals.css"),
  ]);
  assert.match(generator, /<Dialog[\s\S]*title="批量创建核查任务"/);
  assert.match(generator, /<ProjectWorkspace projectId=\{projectId\}/);
  assert.match(generator, /className="lt-scopes"/);
  assert.match(generator, /className="lt-custom-fields"/);
  assert.match(css, /\.lt-scopes\s*\{[^}]*grid-template-columns: repeat\(3/);
  assert.match(generator, /"\/api\/tasks\/generate"/);
  assert.match(generator, /reclassifyCandidates/);
});

test("详情为原型尺寸、报告为编号编辑区、导出为细线统计和固定 footer", async () => {
  const [css, detail, report, exportUI] = await Promise.all([
    source("app/globals.css"),
    source("components/task-drawer.tsx"),
    source("components/project-report-dialog.tsx"),
    source("components/project-export-dialog.tsx"),
  ]);
  assert.match(css, /\.lt-drawer\s*\{[^}]*760px/);
  assert.match(detail, /className="lt-detail-top"/);
  assert.match(detail, /className="lt-detail-meta"/);
  assert.match(report, /className="lt-analysis-field"/);
  assert.match(exportUI, /className="lt-export-summary"/);
  assert.match(exportUI, /footer=\{/);
});

test("正式 UI 不引用 localhost 固定端口或本机资源路径", async () => {
  for (const file of [
    "task-generator",
    "task-form",
    "task-drawer",
    "project-report-dialog",
    "project-export-dialog",
    "workspace-shell",
    "legaltrace-landing",
    "project-workspace",
  ]) {
    assert.doesNotMatch(
      await source(`components/${file}.tsx`),
      /localhost|127\.0\.0\.1|file:\/\/|[A-Z]:\\\\|https?:\/\/[^\s\"']+:\d+/i,
    );
  }
});

const source = (file: string) =>
  readFile(new URL(`../src/${file}`, import.meta.url), "utf8");

test("冻结 LegalTrace 色板与字号来自已确认原型，不保留渐变或玻璃", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /--text-primary: #090909/);
  assert.match(css, /--surface-subtle: #f7f5f5/);
  for (const [name, size] of [
    ["h1", 36],
    ["h2", 24],
    ["h3", 18],
    ["body", 14],
    ["caption", 12],
  ])
    assert.ok(css.includes(`--type-${name}: ${size}px`));
  assert.match(css, /font-variant-numeric: lining-nums/);
  assert.doesNotMatch(
    css,
    /(?:linear|radial)-gradient|#(?:3c4a5e|6f8096|aeb8c4|eef1f5)/i,
  );
  assert.match(
    css,
    /\.lt-dialog::backdrop\s*\{[^}]*backdrop-filter: blur\(3px\);/,
  );
});

test("侧栏保留原项目路由、当前项目标识及原型尺寸", async () => {
  const [shell, css] = await Promise.all([
    source("components/workspace-shell.tsx"),
    source("app/globals.css"),
  ]);
  assert.match(shell, /href=\{`\/projects\/\$\{p.id\}`\}/);
  assert.match(shell, /aria-current=\{p.id === projectId/);
  for (const size of [244, 210, 78, 65])
    assert.ok(css.includes(`--sidebar-width: ${size}px`));
  assert.match(css, /\.lt-workspace::before\s*\{[^}]*background: #060606;/);
  assert.match(css, /\.lt-icon\s*\{[^}]*width: 16px;[^}]*height: 16px;/);
});

test("核查表黑底白字，创建弹窗有独立滚动主体和固定 footer", async () => {
  const [css, dialog, form] = await Promise.all([
    source("app/globals.css"),
    source("components/dialog.tsx"),
    source("components/task-form.tsx"),
  ]);
  assert.match(
    css,
    /\.lt-task-table th\s*\{[^}]*background: #090909;[^}]*color: white;/,
  );
  assert.match(css, /\.lt-dialog-form\s*\{[^}]*800px/);
  assert.match(css, /\.lt-modal-body\s*\{[^}]*overflow-y: auto;/);
  assert.match(css, /\.lt-modal-footer\s*\{[^}]*flex-shrink: 0;/);
  assert.match(dialog, /aria-labelledby=\{titleId\}/);
  assert.match(dialog, /previous\?\.focus\(\)/);
  assert.match(form, /form="task-form"/);
});

test("Landing CTA 仅进入真实登录 UI，鉴权与注册校验保持原入口", async () => {
  const [auth, landing] = await Promise.all([
    source("components/auth-provider.tsx"),
    source("components/legaltrace-landing.tsx"),
  ]);
  assert.match(landing, /onClick=\{onLogin\}/);
  assert.doesNotMatch(landing, /setSession|signIn|localStorage/);
  assert.match(auth, /db.auth.signInWithPassword\(\{/);
  assert.match(auth, /db.auth.signUp\(\{/);
  assert.match(auth, /registrationValidationError\(/);
  assert.match(auth, /name="passwordConfirmation"/);
  assert.match(auth, /getSession\(\)/);
});
