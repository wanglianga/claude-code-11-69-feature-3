/**
 * 全局领域类型定义。
 * 所有持久化对象均带版本字段，结构解析器/提取器升级时可区分解析版本。
 */

// ---------- 计算模式 ----------
export type ComputeMode = 'full' | 'incremental';

// ---------- 文档结构 ----------
export type SectionKind =
  | 'announcement' // 公告正文
  | 'attachment' // 附件摘要
  | 'noise'; // 站点噪声（导航、页脚、版权、广告等）

export interface TextSpan {
  /** 相对原文的字符偏移（基于规范化前原文） */
  start: number;
  end: number;
  /** 片段原文，可直接在界面高亮定位 */
  text: string;
}

export interface StructuredSection {
  kind: SectionKind;
  heading: string;
  span: TextSpan;
}

export interface StructuredDocument {
  parserVersion: string;
  /** 去掉站点噪声后、用于事实提取的正文纯文本 */
  bodyText: string;
  sections: StructuredSection[];
  noiseSpans: TextSpan[];
  /** 原始文件名中的扩展名/来源线索 */
  sourceKind: 'webpage' | 'print' | 'copytext' | 'attachment';
}

// ---------- 快照仓 ----------
export interface FileSource {
  /** 导入时的文件名 */
  fileName: string;
  /** 导入批次 id */
  batchId: string;
  /** 导入时间戳（由调用方传入，保证可复跑） */
  importedAt: number;
  /** 文件大小（字节） */
  size: number;
  /** 可选的来源 URL（网页归档） */
  originUrl?: string;
}

export interface Snapshot {
  id: string;
  /** 内容指纹 SHA-256（十六进制），相同内容不同文件名合并的依据 */
  contentHash: string;
  /** 规范化文本哈希，用于识别空白/排版差异导致的“同件副本” */
  normalizedHash: string;
  /** 原始文本内容 */
  rawText: string;
  /** 合并保存的全部来源记录（同一内容可有多条来源） */
  sources: FileSource[];
  /** 解析结果（首次导入时生成并冻结） */
  parsed: StructuredDocument;
  createdAt: number;
}

export interface ImportBatch {
  id: string;
  label: string;
  createdAt: number;
  /** 本批尝试导入的文件数 */
  inputCount: number;
  /** 新建快照数 */
  newSnapshotCount: number;
  /** 因内容指纹相同而合并来源的文件数 */
  mergedCount: number;
  /** 启动时快照冻结后到达、被推迟到后续批次的文件数 */
  deferredCount: number;
  snapshotIds: string[];
}

// ---------- 事实提取 ----------
export type FactType =
  | 'project_code'
  | 'purchaser'
  | 'lot'
  | 'amount'
  | 'date'
  | 'stage'
  | 'result';

export type ProcurementStage =
  | 'intention' // 意向
  | 'announcement' // 招标/采购公告
  | 'correction' // 更正
  | 'extension' // 延期
  | 'cancellation' // 撤销
  | 'result'; // 中标/成交结果

export interface ExtractionRule {
  id: string;
  ruleVersion: string;
  /** 规则可读描述，发布字段回溯用 */
  description: string;
}

export interface Fact {
  id: string;
  snapshotId: string;
  sectionKind: SectionKind;
  type: FactType;
  /** 规范化值（编号去空格、金额统一为元数值等） */
  value: string;
  /** 金额事实的数值（单位：元），其余类型为 undefined */
  amountCny?: number;
  /** 标段事实携带的标段号 */
  lotCode?: string;
  /** 日期事实携带的 ISO 日期 */
  isoDate?: string;
  /** 阶段事实携带的阶段枚举 */
  stage?: ProcurementStage;
  /** 结果事实携带的中标人 */
  winner?: string;
  evidence: TextSpan;
  /** 由哪条提取规则产生 */
  ruleId: string;
  ruleVersion: string;
  extractorVersion: string;
}

// ---------- 关系求值 ----------
export type EdgeType =
  | 'duplicate' // 同件副本
  | 'stage_chain' // 同一项目阶段演进
  | 'suspected_correction' // 疑似更正
  | 'suspected_restart' // 疑似重启
  | 'conflict'; // 互斥冲突（只能待裁决，禁止自动合并）

export type EdgeStatus = 'pending' | 'confirmed' | 'rejected';

export interface RelationEdge {
  id: string;
  type: EdgeType;
  status: EdgeStatus;
  fromSnapshotId: string;
  toSnapshotId: string;
  /** 求值器给出的可读理由（命中了哪些事实/指纹） */
  reasons: string[];
  /** 共享/冲突的事实键，便于人工复核 */
  evidenceFactIds: string[];
  /** 求值器版本与输入快照水位，保证可复算 */
  evaluatorVersion: string;
  /** 参与计算的全部快照 id（固定快照集） */
  inputSnapshotIds: string[];
  createdAt: number;
}

// ---------- 裁决 ----------
export interface Adjudication {
  id: string;
  edgeId: string;
  decision: 'confirm' | 'reject' | 'split';
  /** 审核结论说明 */
  note: string;
  /** 审核员（本地工作台默认 default-reviewer） */
  reviewer: string;
  /** 裁决适用的证据（事实 id 列表） */
  appliedFactIds: string[];
  createdAt: number;
  /** 被本裁决撤回的旧裁决 id（重新裁决时） */
  supersedesAdjudicationId?: string;
}

export interface WithdrawnEdgeRecord {
  edgeId: string;
  reason: string;
  adjudicationId: string;
  withdrawnAt: number;
}

// ---------- 发布 ----------
export interface PublishedLot {
  lotCode: string;
  lotName: string;
  budgetCny: number | null;
  winner: string | null;
  /** 每个字段都能回溯到事实 → 快照 */
  fieldProvenance: Record<string, { factId: string; snapshotId: string }>;
}

export interface PublishedProject {
  projectCode: string;
  purchaser: string;
  /** 项目链：按日期排序的阶段快照序列 */
  stageChain: { stage: ProcurementStage; snapshotId: string; isoDate: string | null }[];
  lots: PublishedLot[];
  /** 当前适用预算（元），取最新已确认阶段证据 */
  currentBudgetCny: number | null;
  /** 预算变动轨迹（含被更正覆盖的历史值及其依据） */
 BudgetHistory: { amountCny: number; snapshotId: string; isoDate: string | null; ruleId: string }[];
  /** 项目分组合法性依据：确认边与裁决 id */
  supportingEdgeIds: string[];
  supportingAdjudicationIds: string[];
  /** 组内被驳回/拆分的冲突边，留痕说明为何没有自动合并 */
  conflictEdgeIds: string[];
  fieldProvenance: Record<string, { factId: string; snapshotId: string }>;
}

export interface PublicationStats {
  projectCount: number;
  lotCount: number;
  totalBudgetCny: number;
  resultCount: number;
  /** 按省份/采购人维度的简单统计 */
  byPurchaser: Record<string, { projects: number; budgetCny: number }>;
}

export interface Publication {
  id: string;
  version: number;
  createdAt: number;
  /** 发布时的裁决水位（裁决 id 排序集） */
  adjudicationWatermark: string[];
  /** 参与计算的快照水位 */
  snapshotWatermark: string[];
  computeMode: ComputeMode;
  /** 全量：null；增量：实际重算的连通分量 id 与跳过分量数 */
  computeScope: {
    recomputedComponents: string[];
    skippedComponents: number;
    dependencyHash: string;
  };
  evaluatorVersion: string;
  extractorVersion: string;
  parserVersion: string;
  projects: PublishedProject[];
  stats: PublicationStats;
}

// ---------- 运行状态 ----------
export interface PipelineProgress {
  phase: 'idle' | 'parsing' | 'extracting' | 'evaluating' | 'publishing';
  current: number;
  total: number;
  message: string;
}

// ---------- 标段有效投标窗口 ----------

/** 时间条款类别：发布时间、可下载起点、答疑、报名、递交、开标 */
export type TimeClauseKind =
  | 'publish'
  | 'download'
  | 'clarify'
  | 'registration'
  | 'submission'
  | 'opening';

export interface TimeClause {
  id: string;
  snapshotId: string;
  /** 来源材料所属区域（用于绑定区域日历） */
  regionId: string;
  kind: TimeClauseKind;
  /** 原文标签，如“投标截止时间” */
  label: string;
  /** 区域本地日期 YYYY-MM-DD */
  date: string;
  /** 区域本地时刻 HH:mm；null 表示原文只写日期 */
  time: string | null;
  precision: 'date' | 'minute';
  /** 作用标段；null 表示全项目通用条款 */
  lotCode: string | null;
  /** current = 当前有效；reference = 原文引用的被替换历史值 */
  role: 'current' | 'reference';
  evidence: TextSpan;
  ruleId: string;
  ruleVersion: string;
  /** 同快照内的匹配序，保证排序确定 */
  sequence: number;
}

export type WindowSegmentStatus =
  | 'available' // 该版本生效且截止未过
  | 'closed' // 截止已过或项目已终止
  | 'gap' // 旧截止已过、新截止尚未公告的失效空档
  | 'undetermined'; // 时区或日历不可判定

export interface WindowSegment {
  /** 保守起点：原文只见日期时取当日工作结束时刻（不假定全天可用） */
  fromUtc: number;
  /** 保守终点：原文只见日期时取当日 00:00 */
  toUtc: number;
  /** 乐观起点：原文只见日期时取当日 00:00 */
  fromUtcEarliest: number;
  /** 乐观终点：原文只见日期时取当日工作结束时刻 */
  toUtcLatest: number;
  /** 本段实际可用的自然天数范围 */
  naturalDays: { min: number; max: number };
  /** 本段可用工作时长（分钟）范围：日期精度不足或时区不确定时为区间 */
  workMinutes: { min: number; max: number };
  status: WindowSegmentStatus;
  /** 生效版本来源快照 */
  versionSnapshotId: string;
  /** 该段依据的时间条款 id（开始与截止） */
  evidenceClauseIds: string[];
  reasons: string[];
}

export interface ShortenedInterval {
  /** submission = 递交截止被缩短；registration = 报名截止被缩短 */
  kind: 'submission' | 'registration';
  fromUtc: number;
  toUtc: number;
  workMinutes: { min: number; max: number };
  naturalDays: { min: number; max: number };
  replacedBySnapshotId: string;
  reasons: string[];
  evidenceClauseIds: string[];
}

export interface InvalidVisibleWindow {
  kind: 'submission' | 'registration';
  fromUtc: number;
  toUtc: number;
  naturalDays: number;
  reason: string;
  evidenceClauseIds: string[];
}

export type WindowExclusionCode =
  | 'missing-start'
  | 'missing-submission-deadline'
  | 'deadline-before-start'
  | 'unknown-region-calendar'
  | 'timezone-undetermined'
  | 'no-effective-window'
  | 'date-only-precision';

export interface WindowExclusion {
  code: WindowExclusionCode;
  message: string;
  /** true = 该标段被排除出窗口统计；false = 仅标记精度/范围风险 */
  excludesFromStats: boolean;
}

export type ScaleBucket = '小型' | '中型' | '大型' | '未知';

export interface LotWindow {
  projectCode: string;
  lotCode: string;
  lotName: string;
  regionId: string;
  regionName: string;
  timeZone: string;
  offsetMinutes: number;
  procurementMethod: string;
  scaleBucket: ScaleBucket;
  /** 规模依据（项目预算 / 标段预算） */
  scaleBasis: string;
  /** 分析固定的日历版本 */
  calendarVersion: string | null;
  /** 全部时间条款（含 reference 角色） */
  clauses: TimeClause[];
  segments: WindowSegment[];
  effectiveWorkMinutes: { min: number; max: number };
  effectiveNaturalDays: { min: number; max: number };
  shortenedIntervals: ShortenedInterval[];
  invalidVisibleWindows: InvalidVisibleWindow[];
  timeZoneUncertainty: {
    undetermined: boolean;
    offsetRangeMinutes: [number, number] | null;
    utcRange: [number, number] | null;
  } | null;
  exclusions: WindowExclusion[];
  /** 逐条款原文证据（时间证据） */
  evidence: { clauseId: string; snapshotId: string; kind: TimeClauseKind; label: string; text: string; start: number; end: number }[];
}

export interface WindowDistributionRow {
  regionId: string;
  regionName: string;
  procurementMethod: string;
  scaleBucket: ScaleBucket;
  lotCount: number;
  /** 有效工作时长（小时）的最小 / 中位 / 最大值，取每标段区间中点 */
  hoursMin: number;
  hoursMedian: number;
  hoursMax: number;
  excludedCount: number;
}

export interface WindowAnalysis {
  id: string;
  version: number;
  strategy: 'materialized' | 'on_demand';
  computedAt: number;
  /** 日历截止点：取该时刻有效的区域日历版本，历史分析不回填新版本 */
  calendarCutoffAt: number;
  calendarVersions: { regionId: string; regionName: string; version: string; publishedAt: number }[];
  lots: LotWindow[];
  distributions: WindowDistributionRow[];
  exclusions: { code: WindowExclusionCode; lotCount: number; lots: string[] }[];
  notes: string[];
}
