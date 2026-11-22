/**
 * 时间条款提取器：从公告与更正材料中保留
 * 发布时间、可下载起点、答疑、报名、递交、开标时刻及其字符级原文证据。
 *
 * 关键语义：
 *  - “原/由/从”引用的旧时刻标记为 reference（被替换历史值），不得当作现行条款；
 *  - “现/调整/延长/提前/顺延至”后的时刻标记为 current；
 *  - 只写日期未写时刻的条款 precision=date，窗口演算必须按区域预设保守边界给范围；
 *  - 条款带区域（由来源推断）与作用标段（条款所在行出现“第X标段/包件”时收窄）。
 */
import type { Snapshot, StructuredSection, TextSpan, TimeClause, TimeClauseKind } from './types';
import { deterministicId } from './hash';

export const TIME_EXTRACTOR_VERSION = 'time-extractor-1.0.0';

export const TIME_RULES = [
  { id: 'R-TIME-01', ruleVersion: TIME_EXTRACTOR_VERSION, description: '识别公告发布日期/公告日期（原…发布日期记为被替换历史值）' },
  { id: 'R-TIME-02', ruleVersion: TIME_EXTRACTOR_VERSION, description: '识别招标/采购文件获取或下载开始时间' },
  { id: 'R-TIME-03', ruleVersion: TIME_EXTRACTOR_VERSION, description: '识别答疑/澄清/质疑截止时间' },
  { id: 'R-TIME-04', ruleVersion: TIME_EXTRACTOR_VERSION, description: '识别报名时间/报名截止时间' },
  { id: 'R-TIME-05', ruleVersion: TIME_EXTRACTOR_VERSION, description: '识别投标/响应文件递交截止时间（含原值引用与延长/提前后的新值）' },
  { id: 'R-TIME-06', ruleVersion: TIME_EXTRACTOR_VERSION, description: '识别开标时间/开标日期' },
];

const REGION_BY_NAME: [string, string][] = [
  ['浙江', 'ZJ'],
  ['安徽', 'AH'],
  ['四川', 'SC'],
  ['广东', 'GD'],
  ['云南', 'YN'],
];

const REGION_BY_CODE: [RegExp, string][] = [
  [/^ZC\d/i, 'ZJ'],
  [/^HF\d/i, 'AH'],
  [/^SC\d/i, 'SC'],
  [/^GD\d/i, 'GD'],
  [/^YN\d/i, 'YN'],
];

/** 依据来源文件名与项目编号推断区域；未知区域返回 UNKNOWN 供窗口演算标记排除 */
export function inferRegion(snapshot: Snapshot): string {
  const name = snapshot.sources.map((s) => s.fileName).join(' ');
  for (const [needle, region] of REGION_BY_NAME) {
    if (name.includes(needle)) return region;
  }
  const code = /[A-Z]{2}\d{4}[-–][A-Za-z0-9]+/.exec(snapshot.rawText)?.[0] ?? '';
  for (const [re, region] of REGION_BY_CODE) {
    if (re.test(code)) return region;
  }
  return 'UNKNOWN';
}

/** 采购方式（区域compare用；缺失记“未注明”） */
export function inferProcurementMethod(rawText: string): string | null {
  const m = /采购方式[：:]\s*([^\n，,。；;]{2,20})/.exec(rawText);
  return m ? m[1].trim() : null;
}

function ruleOfKind(kind: TimeClauseKind): string {
  switch (kind) {
    case 'publish': return 'R-TIME-01';
    case 'download': return 'R-TIME-02';
    case 'clarify': return 'R-TIME-03';
    case 'registration': return 'R-TIME-04';
    case 'submission': return 'R-TIME-05';
    case 'opening': return 'R-TIME-06';
  }
}

/** 改写句类别判定：先看报名/答疑/获取/开标，再落到递交截止，最后才是发布 */
function pairKindOf(sentence: string): TimeClauseKind {
  if (/报名/.test(sentence)) return 'registration';
  if (/答疑|澄清|质疑/.test(sentence)) return 'clarify';
  if (/获取|下载/.test(sentence)) return 'download';
  if (/开标/.test(sentence)) return 'opening';
  if (/投标|递交|响应文件|提交/.test(sentence)) return 'submission';
  return 'publish';
}

function toIso(y: string, m: string, d: string): string {
  return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

function normTime(t: string | undefined): string | null {
  if (!t) return null;
  const [h, m] = t.replace('：', ':').split(':');
  return `${String(Number(h)).padStart(2, '0')}:${m.padStart(2, '0')}`;
}

function lotOnLine(text: string, offset: number): string | null {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const line = text.slice(lineStart, text.indexOf('\n', offset) === -1 ? text.length : text.indexOf('\n', offset));
  const m = /(第[一二三四五六七八九十百0-9]+(?:标段|标包|包件|包))|(包件\s*[0-9A-Za-z]+)/.exec(line);
  if (!m) return null;
  return m[1] ?? m[2].replace(/\s+/g, '');
}

interface Draft {
  kind: TimeClauseKind;
  label: string;
  date: string;
  time: string | null;
  role: 'current' | 'reference';
  lotCode: string | null;
  evidence: TextSpan;
  ruleId: string;
  offset: number;
}

const DATE = String.raw`(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}[:：]\d{2}))?`;

function buildClause(snapshotId: string, regionId: string, d: Draft, sequence: number): TimeClause {
  return {
    id: deterministicId('clause', [snapshotId, d.kind, d.date, d.time ?? '', d.role, d.lotCode ?? '', d.offset]),
    snapshotId,
    regionId,
    kind: d.kind,
    label: d.label,
    date: d.date,
    time: d.time,
    precision: d.time ? 'minute' : 'date',
    lotCode: d.lotCode,
    role: d.role,
    evidence: d.evidence,
    ruleId: d.ruleId,
    ruleVersion: TIME_EXTRACTOR_VERSION,
    sequence,
  };
}

/** 扫描单个 section，返回原文偏移修正后的条款草稿 */
function draftsOfSection(section: StructuredSection): Draft[] {
  const text = section.span.text;
  const base = section.span.start;
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  const dateRe = new RegExp(DATE, 'g');
  const push = (
    kind: TimeClauseKind,
    label: string,
    date: string,
    time: string | null,
    role: 'current' | 'reference',
    localStart: number,
    localEnd: number,
    offset: number,
  ) => {
    const key = `${kind}|${date}|${time ?? ''}|${role}`;
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push({
      kind,
      label,
      date,
      time,
      role,
      lotCode: lotOnLine(text, offset),
      evidence: { start: base + localStart, end: base + localEnd, text: text.slice(localStart, localEnd) },
      ruleId: ruleOfKind(kind),
      offset: base + offset,
    });
  };

  // 1) 成对改写句：“原 …<旧时刻> … 延长/提前/调整/顺延 … 至 <新时刻>”
  //    旧值保留为 reference（实际可见过的失效窗口），新值记为 current。
  const pair = new RegExp(
    String.raw`(?:原|由|从)[^。；\n]{0,20}?${DATE}[^。；\n]{0,60}?(?:提前|延长|调整|顺延|变更)[^。；\n]{0,16}?至\s*${DATE}`,
    'g',
  );
  for (const m of text.matchAll(pair)) {
    const sentence = m[0] ?? '';
    const kind = pairKindOf(sentence);
    const label =
      kind === 'registration' ? '报名截止时间'
      : kind === 'clarify' ? '答疑截止时间'
      : kind === 'download' ? '获取/下载时间'
      : kind === 'opening' ? '开标时间'
      : kind === 'submission' ? '投标截止时间'
      : '公告发布日期';
    const dates = [...m[0].matchAll(dateRe)];
    if (dates.length < 2) continue;
    const first = dates[0];
    const second = dates[dates.length - 1];
    const toClause = (dm: RegExpMatchArray, role: 'current' | 'reference') => {
      const localStart = (m.index ?? 0) + (dm.index ?? 0);
      const localEnd = localStart + dm[0].length;
      push(kind, label, toIso(dm[1], dm[2], dm[3]), normTime(dm[4]), role, localStart, localEnd, localStart);
    };
    toClause(first, 'reference');
    toClause(second, 'current');
  }

  // 2) 通用标签 + 日期（可带时刻）：逐类标签扫描，与同句首个日期配对。
  //    标签前 10 个字符内出现“原”时记为 reference。
  const LABELS: { re: RegExp; kind: TimeClauseKind }[] = [
    { re: /(?:公告发布日期|公告日期|发布日期)/g, kind: 'publish' },
    { re: /(?:投标截止时间|递交[^，。；\n]{0,8}?截止时间|响应文件[^，。；\n]{0,8}?截止时间|提交[^，。；\n]{0,6}?截止时间)/g, kind: 'submission' },
    { re: /(?:报名(?:截止)?时间)/g, kind: 'registration' },
    { re: /(?:答疑(?:截止)?时间|澄清(?:截止)?时间|质疑截止时间)/g, kind: 'clarify' },
    { re: /(?:(?:招标文件|采购文件|文件)?获取[^，。；\n]{0,10}?时间|下载[^，。；\n]{0,10}?时间)/g, kind: 'download' },
    { re: /(?:开标(?:时间|日期))/g, kind: 'opening' },
  ];
  for (const { re, kind } of LABELS) {
    for (const m of text.matchAll(re)) {
      const labelStart = m.index ?? 0;
      const labelEnd = labelStart + m[0].length;
      const tailStart = labelEnd;
      const lineStart = text.lastIndexOf('\n', labelStart) + 1;
      const lineEnd = text.indexOf('\n', tailStart);
      const sentEnd = text.indexOf('。', tailStart);
      const bound = Math.min(
        lineEnd === -1 ? text.length : lineEnd,
        sentEnd === -1 ? text.length : sentEnd,
      );
      const tail = text.slice(tailStart, bound);
      const dm = new RegExp(DATE).exec(tail);
      if (!dm) continue;
      const dateLocal = tailStart + (dm.index ?? 0);
      const prefix = text.slice(Math.max(lineStart, labelStart - 10), labelStart);
      const role: 'current' | 'reference' = /原/.test(prefix) ? 'reference' : 'current';
      push(
        kind,
        m[0],
        toIso(dm[1], dm[2], dm[3]),
        normTime(dm[4]),
        role,
        dateLocal,
        dateLocal + dm[0].length,
        labelStart,
      );
    }
  }

  return drafts;
}

/** 提取单个快照的全部时间条款（确定性排序） */
export function extractTimeClauses(snapshot: Snapshot, regionId = inferRegion(snapshot)): TimeClause[] {
  const out: TimeClause[] = [];
  let seq = 0;
  for (const section of snapshot.parsed.sections) {
    if (section.kind === 'noise') continue;
    const drafts = draftsOfSection(section);
    for (const d of drafts) {
      out.push(buildClause(snapshot.id, regionId, d, seq));
      seq += 1;
    }
  }
  return out.sort((a, b) => a.evidence.start - b.evidence.start || a.kind.localeCompare(b.kind));
}

export function extractAllTimeClauses(snapshots: Snapshot[]): TimeClause[] {
  return snapshots.flatMap((s) => extractTimeClauses(s));
}

export const TIME_CLAUSE_KIND_LABELS: Record<TimeClauseKind, string> = {
  publish: '发布时间',
  download: '下载起点',
  clarify: '答疑',
  registration: '报名',
  submission: '递交截止',
  opening: '开标',
};

/** 从快照原文提取首个项目编号（用于窗口分组的稳定键） */
export function projectCodeOf(snapshot: Snapshot): string | null {
  const labeled = /(?:项目编号|采购编号|招标编号|项目编码)[：:]\s*([A-Za-z0-9][A-Za-z0-9\-_/（）()]*[A-Za-z0-9])/.exec(snapshot.rawText);
  if (labeled) return labeled[1].replace(/[（）()]/g, '').trim();
  const bare = /\b[A-Z]{2,}\d{4}[-–][A-Za-z0-9]+(?:[-–][A-Za-z0-9]+)*/.exec(snapshot.rawText);
  return bare ? bare[0] : null;
}
