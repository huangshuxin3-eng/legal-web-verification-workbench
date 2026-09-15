export type TaskScopePreset = {
  id: string;
  category: "基础信息" | "司法风险" | "行政监管" | "知识产权" | "其他";
  topic: string;
  sourceName: string;
  sourceUrl: string | null;
  defaultSelected: boolean;
};

// URLs intentionally remain null until they have been explicitly verified and
// configured. The generator never learns URLs from historical Tasks.
export const TASK_SCOPE_PRESETS: readonly TaskScopePreset[] = [
  {
    id: "business",
    category: "基础信息",
    topic: "工商信息",
    sourceName: "国家企业信用信息公示系统",
    sourceUrl: "https://www.gsxt.gov.cn/index.html",
    defaultSelected: true,
  },
  {
    id: "enforcement",
    category: "司法风险",
    topic: "执行",
    sourceName: "中国执行信息公开网",
    sourceUrl: "https://zxgk.court.gov.cn/",
    defaultSelected: true,
  },
  {
    id: "dishonesty",
    category: "司法风险",
    topic: "失信",
    sourceName: "中国执行信息公开网",
    sourceUrl: "https://zxgk.court.gov.cn/",
    defaultSelected: true,
  },
  {
    id: "litigation",
    category: "司法风险",
    topic: "诉讼",
    sourceName: "中国裁判文书网",
    sourceUrl: "https://wenshu.court.gov.cn/",
    defaultSelected: true,
  },
  {
    id: "court-notice",
    category: "司法风险",
    topic: "法院公告",
    sourceName: "人民法院公告网",
    sourceUrl: "https://rmfygg.court.gov.cn/",
    defaultSelected: true,
  },
  {
    id: "consumption-limit",
    category: "司法风险",
    topic: "限制消费",
    sourceName: "中国执行信息公开网",
    sourceUrl: "https://zxgk.court.gov.cn/",
    defaultSelected: false,
  },
  {
    id: "bankruptcy",
    category: "司法风险",
    topic: "破产",
    sourceName: "全国企业破产重整案件信息网",
    sourceUrl: null,
    defaultSelected: false,
  },
  {
    id: "administrative",
    category: "行政监管",
    topic: "行政处罚 / 信用",
    sourceName: "信用中国",
    sourceUrl: null,
    defaultSelected: false,
  },
  {
    id: "trademark",
    category: "知识产权",
    topic: "商标",
    sourceName: "国家知识产权局相关查询入口",
    sourceUrl: "https://sbj.cnipa.gov.cn/",
    defaultSelected: true,
  },
  {
    id: "patent",
    category: "知识产权",
    topic: "专利",
    sourceName: "国家知识产权局专利检索及分析系统",
    sourceUrl: "https://pss-system.cponline.cnipa.gov.cn/conventionalSearch",
    defaultSelected: true,
  },
  {
    id: "securities",
    category: "其他",
    topic: "证券监管",
    sourceName: "证监会 / 交易所",
    sourceUrl: null,
    defaultSelected: false,
  },
  {
    id: "news",
    category: "其他",
    topic: "新闻舆情",
    sourceName: "用户指定网站",
    sourceUrl: null,
    defaultSelected: false,
  },
] as const;
