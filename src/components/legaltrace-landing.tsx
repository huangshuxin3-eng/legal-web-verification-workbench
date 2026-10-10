import { LegalTraceIcon } from "./legaltrace-icon";

export function LegalTraceLanding({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="lt-home">
      <header className="lt-home-header">
        <span className="lt-wordmark">LegalTrace</span>
        <nav aria-label="账号入口" className="lt-home-nav">
          <button className="btn" onClick={onLogin}>
            登录
          </button>
          <button className="btn primary" onClick={onLogin}>
            立即核查
          </button>
        </nav>
      </header>
      <section className="lt-hero">
        <h1>
          让法律核查更高效
          <br />
          让每项结论有据可查
        </h1>
        <div className="lt-hero-copy">
          <p>
            LegalTrace
            为律师提供公开信息查询、证据留存与报告生成的一体化工作台。AI
            辅助梳理与分析，专业判断始终由你掌握。
          </p>
          <button className="btn primary" onClick={onLogin}>
            立即核查
          </button>
        </div>
      </section>
      <section className="lt-product-stage" aria-label="工作台示例">
        <p className="lt-stage-caption">核查工作台</p>
        <div className="lt-mini-workspace">
          <aside className="lt-mini-sidebar">
            <span className="lt-wordmark">LegalTrace</span>
            <p>项目</p>
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={`lt-mini-project ${n === 1 ? "active" : ""}`}
              >
                <LegalTraceIcon name="briefcase" />
                Project {n}
              </div>
            ))}
            <small>LT · 演示工作区</small>
          </aside>
          <div className="lt-mini-main">
            <h2>Project 1</h2>
            <div className="lt-mini-stats">
              <span>32 项核查任务</span>
              <span>10 项已完成</span>
              <span>26 份证据留痕</span>
            </div>
            <div className="lt-mini-actions">
              {["新建核查任务", "批量创建", "生成报告", "导出项目"].map(
                (label) => (
                  <span key={label}>{label}</span>
                ),
              )}
            </div>
            <div className="lt-mini-search">
              <LegalTraceIcon name="search" />
              搜索核查对象、事项或数据来源
            </div>
            <table>
              <thead>
                <tr>
                  <th>核查对象</th>
                  <th>核查事项</th>
                  <th>数据来源</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["工商信息", "国家企业信用信息公示系统", "未开始"],
                  ["执行", "中国执行信息公开网", "进行中"],
                  ["失信", "中国执行信息公开网", "已完成"],
                  ["诉讼", "中国裁判文书网", "未开始"],
                ].map(([topic, source, status]) => (
                  <tr key={topic}>
                    <td>远川科技有限公司</td>
                    <td>{topic}</td>
                    <td>{source}</td>
                    <td>{status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="lt-mini-pagination">
              <span>每页数量 25</span>
              <span>上一页　 第 1 / 2 页　 下一页</span>
            </div>
            <small>公开信息查询 · 证据留存 · 人工复核 · 报告交付</small>
          </div>
        </div>
      </section>
      <footer className="lt-home-footer">
        <span className="lt-serif">LegalTrace</span>
        <span>专业判断，由你掌握。</span>
        <span>上方为工作台示例</span>
      </footer>
    </main>
  );
}
