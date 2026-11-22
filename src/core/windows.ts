/**
 * 窗口演算器：按标段把原始时间线切成生效区间，
 * 计算自然时长、可用工作时长、被更正缩短的区间及无法确定的时区范围。
 *
 * 关键语义（与需求一一对应）：
 *  - 只写日期未写时刻的条款按区域预设的“保守边界”给出 [min,max] 范围，不假定全天可用；
 *  - 更正发布时间晚于已被替换的截止时，保留实际可见的失效空档，绝不把新截止倒填为全程可用；
 *  - 被更正缩短的区间单独输出并附证据；
 *  - 区域日历无法解析时，窗口标记为无法确定时区并排除出统计；
 *  - 两种实现策略（物化区间 / 按查询即时推演）必须得到相同的有效时长。
 */
import type {
  Fact,
  LotWindow,
  ScaleBucket,
  Snapshot,
  TimeClause,
  TimeClauseKind,
  WindowExclusion,
  WindowSegment,
} from './types';
import type { RegionCalendar } from './calendar';
import { CalendarRegistry, localToUtc, utcToLocal, workMinutesBetween } from './calendar';
import { extractAllTimeClauses, inferProcurementMethod, inferRegion, projectCodeOf } from './timeClauses';
import { normalizeCode } from './evaluator';

export const WINDOW_ENGINE_VERSION = 'window-engine-1.0.0';

export interface WindowComputeOptions {
  strategy: 'materialized' | 'on_demand';
  /** 日历截止点：只用该时刻及之前发布、且对历史日期有效的日历版本 */
  calendarCutoffAt: number;
}

interface SnapshotMeta {
  snapshot: Snapshot;
  projectCode: string;
  regionId: string;
  method: string | null;
  stage: string | null;
  /** 该快照的公告发布时刻（UTC 毫秒），用于排序版本 */
  publishAt: number | null;
  /** 该快照的发布日期条款（用于取发布时刻边界） */
  publishClause: TimeClause | null;
  amountCny: number | null;
}

interface LotContext {
  projectCode: string;
  lotCode: string;
  lotName: string;
  regionId: string;
  method: string;
  projectBudget: number | null;
  lotBudget: number | null;
  clauses: TimeClause[];
  snapshots: SnapshotMeta[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function relevantClauses(clauses: TimeClause[], lotCode: string): TimeClause[] {
  return clauses
    .filter((c) => c.lotCode === null || c.lotCode === lotCode || lotCode === '__ALL__')
    .sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        a.date.localeCompare(b.date) ||
        (a.time ?? '').localeCompare(b.time ?? '') ||
        (a.snapshotId ?? '').localeCompare(b.snapshotId ?? '') ||
        a.sequence - b.sequence,
    );
}

function scaleOf(budget: number | null): { bucket: ScaleBucket; basis: string } {
  if (budget === null) return { bucket: '未知', basis: '无预算事实' };
  if (budget < 2_000_000) return { bucket: '小型', basis: `预算 ${(budget / 10000).toFixed(2)} 万元 < 200 万` };
  if (budget < 10_000_000) return { bucket: '中型', basis: `预算 ${(budget / 10000).toFixed(2)} 万元 ∈ [200 万, 1000 万)` };
  return { bucket: '大型', basis: `预算 ${(budget / 10000).toFixed(2)} 万元 ≥ 1000 万` };
}

// ---------- 边界换算：日期精度不足时给出保守/乐观区间 ----------

interface Bound {
  /** 保守（可用时长更小） */
  cons: number;
  /** 乐观（可用时长更大） */
  opt: number;
  wholeDay: boolean;
}

function startBound(calendar: RegionCalendar, clause: TimeClause): Bound {
  const { from, wholeDay } = localToUtc(clause.date, clause.time, calendar.offsetMinutes);
  if (!wholeDay) return { cons: from, opt: from, wholeDay: false };
  // 只见日期：保守按当日工作结束（可用更少），乐观按当日 00:00
  const { offsetMinutes } = calendar;
  const [y, m, d] = clause.date.split('-').map(Number);
  const workEnd = Date.UTC(y, m - 1, d) + hmToMs(calendar.dailyWorkHours.end) - offsetMinutes * 60 * 1000;
  return { cons: workEnd, opt: from, wholeDay: true };
}

function endBound(calendar: RegionCalendar, clause: TimeClause): Bound {
  const { from, wholeDay } = localToUtc(clause.date, clause.time, calendar.offsetMinutes);
  if (!wholeDay) return { cons: from, opt: from, wholeDay: false };
  // 只见日期：保守按当日 00:00 截止，乐观按当日工作结束
  const { offsetMinutes } = calendar;
  const [y, m, d] = clause.date.split('-').map(Number);
  const workEnd = Date.UTC(y, m - 1, d) + hmToMs(calendar.dailyWorkHours.end) - offsetMinutes * 60 * 1000;
  return { cons: from, opt: workEnd, wholeDay: true };
}

/** 发布日期只见日期时，发布时刻的保守/乐观边界 */
function publishBound(calendar: RegionCalendar, clause: TimeClause): Bound {
  const at = localToUtc(clause.date, clause.time, calendar.offsetMinutes).from;
  if (clause.precision === 'minute') return { cons: at, opt: at, wholeDay: false };
  const [y, m, d] = clause.date.split('-').map(Number);
  const workEnd = Date.UTC(y, m - 1, d) + hmToMs(calendar.dailyWorkHours.end) - calendar.offsetMinutes * 60 * 1000;
  return { cons: workEnd, opt: at, wholeDay: true };
}

function hmToMs(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return (h * 60 + m) * 60 * 1000;
}

function minutesRange(calendar: RegionCalendar, from: Bound, to: Bound): { min: number; max: number } {
  const min = workMinutesBetween(calendar, from.cons, to.cons);
  const max = workMinutesBetween(calendar, from.opt, to.opt);
  return { min: Math.round(min * 1000) / 1000, max: Math.round(Math.max(min, max) * 1000) / 1000 };
}

function naturalRange(from: Bound, to: Bound): { min: number; max: number } {
  const min = Math.max(0, to.cons - from.cons) / DAY_MS;
  const max = Math.max(0, to.opt - from.opt) / DAY_MS;
  return { min: round2(Math.min(min, max)), max: round2(Math.max(min, max)) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------- 时间线切分（与日历无关，供两种策略复用并以不同方式持有） ----------

interface Interval {
  from: Bound;
  to: Bound;
  status: 'available' | 'gap' | 'closed' | 'undetermined';
  versionSnapshotId: string;
  evidenceClauseIds: string[];
  reasons: string[];
}

interface TimelineResult {
  intervals: Interval[];
  shortened: { kind: 'submission' | 'registration'; from: Bound; to: Bound; replacedBySnapshotId: string; evidenceClauseIds: string[]; reasons: string[] }[];
  invalid: { kind: 'submission' | 'registration'; from: Bound; to: Bound; reason: string; evidenceClauseIds: string[] }[];
  currentDeadline: TimeClause | null;
  currentRegistration: TimeClause | null;
  startClause: TimeClause | null;
  exclusions: WindowExclusion[];
  cancelledAt: number | null;
}

/** 决定窗口终点：优先递交截止，缺失时退回报名截止 */
function pickWinningDeadline(candidates: TimeClause[]): TimeClause | null {
  const priority = (k: TimeClauseKind) => (k === 'submission' ? 0 : k === 'registration' ? 1 : k === 'opening' ? 2 : 9);
  return (
    [...candidates]
      .sort((a, b) => priority(a.kind) - priority(b.kind) || dateKey(a).localeCompare(dateKey(b)) || a.snapshotId.localeCompare(b.snapshotId))[0] ??
    null
  );
}

/**
 * 窗口起点：优先投标公告/更正/延期阶段的“下载起点”，其次其“发布日期”；
 * 采购意向与结果公告不作为起点；无阶段事实时退化为任意发布/下载条款。
 */
function pickStart(ctx: LotContext): TimeClause | null {
  const eligibleSnapshots = new Set(
    ctx.snapshots
      .filter((s) => s.stage === null || s.stage === 'announcement' || s.stage === 'correction' || s.stage === 'extension')
      .map((s) => s.snapshot.id),
  );
  const eligible = ctx.clauses.filter(
    (c) => c.role === 'current' && eligibleSnapshots.has(c.snapshotId),
  );
  const pool = eligible.length ? eligible : ctx.clauses.filter((c) => c.role === 'current');
  const pick = (kind: TimeClauseKind) =>
    pool
      .filter((c) => c.kind === kind)
      .sort((a, b) => dateKey(a).localeCompare(dateKey(b)) || a.snapshotId.localeCompare(b.snapshotId))[0] ?? null;
  return pick('download') ?? pick('publish') ?? pick('registration');
}

/**
 * 起点基准：窗口起点取“起点条款”与“首版本发布时刻”的较晚者，
 * 防止把更正发布前的时间误计为可使用（新截止不得倒填为全程可用）。
 * 起点只精确到日期且属于更正/延期材料时，发布时刻按保守边界处理。
 */
function baselineStart(
  calendar: RegionCalendar,
  startClause: TimeClause,
  ctx: LotContext,
): Bound {
  const start = startBound(calendar, startClause);
  const startMeta = ctx.snapshots.find((s) => s.snapshot.id === startClause.snapshotId);
  const revisionLike = startMeta?.stage === 'correction' || startMeta?.stage === 'extension';
  if (!revisionLike) return start;
  const pb = publishBound(calendar, startMeta?.publishClause ?? startClause);
  return { cons: Math.max(start.cons, pb.cons), opt: Math.max(start.opt, pb.opt), wholeDay: start.wholeDay && pb.wholeDay };
}

/**
 * 从条款集合切分生效区间。顺序完全由条款日期、时刻与快照 id 决定，
 * 不依赖存储顺序；两种策略分别“物化后聚合”与“即时推演”。
 */
function buildTimeline(ctx: LotContext, calendar: RegionCalendar | null): TimelineResult {
  const exclusions: WindowExclusion[] = [];
  const clauses = relevantClauses(ctx.clauses, ctx.lotCode);

  // 终止时点（若项目在同一分组内被撤销）：取撤销阶段快照的最早发布日期
  const cancelledMeta = ctx.snapshots
    .filter((s) => s.stage === 'cancellation' && s.publishAt !== null)
    .sort((a, b) => (a.publishAt! - b.publishAt!) || a.snapshot.id.localeCompare(b.snapshot.id))[0];
  const cancelledAt = cancelledMeta?.publishAt ?? null;

  const submissions = clauses.filter((c) => c.kind === 'submission');
  const currentSubs = submissions
    .filter((c) => c.role === 'current')
    .sort((a, b) => dateKey(a).localeCompare(dateKey(b)) || a.snapshotId.localeCompare(b.snapshotId));
  const registrations = clauses.filter((c) => c.kind === 'registration' && c.role === 'current');
  // 终点条款类别：无递交截止而退回报名截止时，失效/缩短区间也必须标记为 registration
  const deadlineKind: 'submission' | 'registration' = currentSubs.length > 0 ? 'submission' : 'registration';

  const startClause = pickStart(ctx);
  const winningDeadline = pickWinningDeadline([...currentSubs, ...registrations]);
  if (!startClause) {
    exclusions.push({
      code: 'missing-start',
      message: '未找到发布时间/下载起点等可确定窗口起点的条款',
      excludesFromStats: true,
    });
  }
  if (currentSubs.length === 0) {
    exclusions.push({
      code: 'missing-submission-deadline',
      message:
        registrations.length > 0
          ? '未找到现行递交截止时间条款，暂以报名截止作为窗口终点'
          : '未找到现行递交截止时间条款',
      excludesFromStats: registrations.length === 0,
    });
  }
  const hasDateOnly = clauses.some((c) => c.precision === 'date');
  if (!calendar) {
    exclusions.push({
      code: 'unknown-region-calendar',
      message: `区域 ${ctx.regionId} 无可用日历版本，无法计算可用工作时长与时区`,
      excludesFromStats: true,
    });
    exclusions.push({
      code: 'timezone-undetermined',
      message: '时区无法确定，窗口 UTC 范围按全球时区跨度给出',
      excludesFromStats: true,
    });
    // 无日历即无法换算本地时刻：仍按“日期视为 UTC”给出名义窗口，
    // 由 aggregateIntervals 展开为跨全球时区的 ±范围，仅用于说明不确定性，不计入统计。
    const neutralIntervals: Interval[] = [];
    const neutralDeadline = pickWinningDeadline([...currentSubs, ...registrations]);
    if (startClause && neutralDeadline) {
      const toUtcAt = (c: TimeClause) => {
        const [y, m, d] = c.date.split('-').map(Number);
        const [hh, mm] = c.time ? c.time.split(':').map(Number) : [0, 0];
        return Date.UTC(y, m - 1, d, hh, mm);
      };
      const startAt = toUtcAt(startClause);
      const endAt = toUtcAt(neutralDeadline);
      neutralIntervals.push({
        from: { cons: startAt, opt: startAt, wholeDay: startClause.precision === 'date' },
        to: { cons: endAt, opt: endAt, wholeDay: neutralDeadline.precision === 'date' },
        status: 'undetermined',
        versionSnapshotId: neutralDeadline.snapshotId,
        evidenceClauseIds: [startClause.id, neutralDeadline.id],
        reasons: ['区域日历未知：按日期视为 UTC 的名义窗口，实际因时区不同而偏移'],
      });
    }
    return {
      intervals: neutralIntervals,
      shortened: [],
      invalid: [],
      currentDeadline: neutralDeadline,
      currentRegistration: null,
      startClause,
      exclusions,
      cancelledAt,
    };
  }

  const intervals: Interval[] = [];
  const shortened: TimelineResult['shortened'] = [];
  const invalid: TimelineResult['invalid'] = [];

  if (!startClause || !winningDeadline) {
    exclusions.push({
      code: 'no-effective-window',
      message: '窗口起点或终点条款缺失，无法形成可计算的投标窗口',
      excludesFromStats: true,
    });
    return { intervals, shortened, invalid, currentDeadline: currentSubs[0] ?? null, currentRegistration: registrations[0] ?? null, startClause, exclusions, cancelledAt };
  }

  // 现行截止按快照版本排序：同一快照的多次出现只取首个。
  // 递交截止存在时以递交截止为终点；缺失时退回报名截止。
  const deadlineCandidates = currentSubs.length > 0 ? currentSubs : registrations;
  const versions: { snapshotId: string; deadline: TimeClause; publishAt: number; publishBound: Bound }[] = [];

  // 仅更正材料自带“原…”被替换值（尚无原公告现行值时）也纳入时间线，
  // 保证仅导入更正公告时仍能还原“实际可见的失效/缩短”区间。
  const currentDeadlineKeys = new Set(deadlineCandidates.map(dateKey));
  const orphanReferences = clauses
    .filter((c) => c.role === 'reference' && c.kind === deadlineCandidates[0]?.kind && !currentDeadlineKeys.has(dateKey(c)))
    .sort((a, b) => dateKey(a).localeCompare(dateKey(b)) || a.snapshotId.localeCompare(b.snapshotId));
  for (const ref of orphanReferences) {
    versions.push({
      snapshotId: ref.snapshotId,
      deadline: ref,
      publishAt: Number.NEGATIVE_INFINITY,
      publishBound: { cons: Number.NEGATIVE_INFINITY, opt: Number.NEGATIVE_INFINITY, wholeDay: false },
    });
  }

  for (const c of deadlineCandidates) {
    const meta = ctx.snapshots.find((s) => s.snapshot.id === c.snapshotId);
    const publishAt = meta?.publishAt ?? localToUtc(c.date, c.time, calendar.offsetMinutes).from;
    if (versions.some((v) => v.snapshotId === c.snapshotId && v.deadline.role === 'current')) continue;
    // 发布日期只见日期：发布时刻是不确定的区间，保守端取当日工作结束。
    // 仅在“更正/延期”材料中把发布日期视作新时限生效时刻；原公告不应据此制造失效空档。
    const revisionLike = meta?.stage === 'correction' || meta?.stage === 'extension';
    const pb: Bound = revisionLike
      ? publishBound(calendar, meta?.publishClause ?? c)
      : { cons: Number.NEGATIVE_INFINITY, opt: Number.NEGATIVE_INFINITY, wholeDay: false };
    versions.push({ snapshotId: c.snapshotId, deadline: c, publishAt, publishBound: pb });
  }
  versions.sort(
    (a, b) =>
      a.publishAt - b.publishAt ||
      (a.deadline.role === 'reference' ? -1 : 1) - (b.deadline.role === 'reference' ? -1 : 1) ||
      a.snapshotId.localeCompare(b.snapshotId),
  );
  const start = baselineStart(calendar, startClause, ctx);

  // 版本演进：维护单一连续可用区间，避免“延期发布在旧截止之前”造成区间重叠重复计数
  let currentEnd = endBound(calendar, versions[0].deadline);
  if (currentEnd.cons < start.cons) {
    exclusions.push({
      code: 'deadline-before-start',
      message: `首个截止 ${versions[0].deadline.date} 早于窗口起点 ${startClause.date}，无法形成有效窗口`,
      excludesFromStats: true,
    });
  } else {
    intervals.push({
      from: start,
      to: currentEnd,
      status: 'available',
      versionSnapshotId: versions[0].snapshotId,
      evidenceClauseIds: [startClause.id, versions[0].deadline.id],
      reasons: ['从可下载/发布起点起算，至首个现行截止'],
    });
  }

  for (let i = 1; i < versions.length; i++) {
    const v = versions[i];
    const prevVersion = versions[i - 1];
    const prevDeadlineClause = prevVersion.deadline;
    const newEnd = endBound(calendar, v.deadline);
    const publishLocal = utcToLocal(v.publishAt, calendar.offsetMinutes);
    const publishCons = v.publishBound.cons;

    if (publishCons <= currentEnd.cons) {
      // 更正在窗口仍然有效时到达：延长则续接，提前则截断并留痕
      if (newEnd.cons > currentEnd.cons) {
        intervals.push({
          from: currentEnd,
          to: newEnd,
          status: 'available',
          versionSnapshotId: v.snapshotId,
          evidenceClauseIds: [prevDeadlineClause.id, v.deadline.id],
          reasons: [
            `截止由 ${prevDeadlineClause.date} ${prevDeadlineClause.time ?? ''} 延长至 ${v.deadline.date} ${v.deadline.time ?? ''}`.trim(),
            '续接原可用区间，无空档',
          ],
        });
      } else if (newEnd.cons < currentEnd.cons) {
        shortened.push({
          kind: deadlineKind,
          from: newEnd,
          to: currentEnd,
          replacedBySnapshotId: v.snapshotId,
          evidenceClauseIds: [prevDeadlineClause.id, v.deadline.id],
          reasons: [
            `截止由 ${prevDeadlineClause.date} ${prevDeadlineClause.time ?? ''} 提前至 ${v.deadline.date} ${v.deadline.time ?? ''}`.trim(),
            '被缩短的区段单独留痕，不计入有效工作时长',
          ],
        });
        const last = intervals[intervals.length - 1];
        if (last) {
          last.to = newEnd;
          last.reasons.push('被后续更正提前截断');
        }
      }
      currentEnd = newEnd;
      continue;
    }

    // 更正发布晚于旧截止：保留实际可见的失效空档，绝不把新截止倒填为全程可用
    const gapTo: Bound = v.publishBound;
    intervals.push({
      from: { cons: currentEnd.cons, opt: currentEnd.opt, wholeDay: false },
      to: gapTo,
      status: 'gap',
      versionSnapshotId: v.snapshotId,
      evidenceClauseIds: [prevDeadlineClause.id, v.deadline.id],
      reasons: [
        `更正/延期于 ${publishLocal.date}${v.publishBound.wholeDay ? '（日期精度）' : ' ' + publishLocal.time} 发布，晚于原截止 ${prevDeadlineClause.date} ${prevDeadlineClause.time ?? ''}`.trim(),
        '该区间内实际无有效截止，按可见失效窗口保留，不倒填新截止',
      ],
    });
    invalid.push({
      kind: deadlineKind,
      from: { cons: currentEnd.cons, opt: currentEnd.opt, wholeDay: false },
      to: gapTo,
      reason:
        deadlineKind === 'registration'
          ? '更正发布晚于原报名截止，报名失效窗口'
          : '更正发布晚于原截止，实际可见的失效窗口',
      evidenceClauseIds: [prevDeadlineClause.id, v.deadline.id],
    });
    if (newEnd.cons > publishCons) {
      intervals.push({
        from: gapTo,
        to: newEnd,
        status: 'available',
        versionSnapshotId: v.snapshotId,
        evidenceClauseIds: [v.deadline.id],
        reasons: [`新截止于更正发布后重新开放至 ${v.deadline.date} ${v.deadline.time ?? ''}`.trim()],
      });
      currentEnd = newEnd;
    } else {
      exclusions.push({
        code: 'no-effective-window',
        message: `更正后的截止 ${v.deadline.date} 早于其发布时刻，未形成新的可用窗口`,
        excludesFromStats: true,
      });
    }
  }

  // 报名截止被更正缩短 / 失效窗口（独立于递交截止）。
  // 现行走势 + 更正材料自带的“原…”被替换值共同构成报名版本序列。
  const regCurrentKeys = new Set(registrations.map(dateKey));
  // 终点已退回报名截止时，报名演进已在主时间线处理，避免重复计入
  const skipRegLoop = deadlineKind === 'registration';
  const regOrphans = clauses
    .filter((c) => c.kind === 'registration' && c.role === 'reference' && !regCurrentKeys.has(dateKey(c)))
    .sort((a, b) => dateKey(a).localeCompare(dateKey(b)) || a.snapshotId.localeCompare(b.snapshotId));
  const regByDate = [...regOrphans, ...registrations].sort(
    (a, b) =>
      dateKey(a).localeCompare(dateKey(b)) ||
      (a.role === 'reference' ? -1 : 1) - (b.role === 'reference' ? -1 : 1),
  );
  for (let i = 1; !skipRegLoop && i < regByDate.length; i++) {
    const prevReg = regByDate[i - 1];
    const nextReg = regByDate[i];
    const prevEnd = endBound(calendar, prevReg);
    const nextEnd = endBound(calendar, nextReg);
    const meta = ctx.snapshots.find((s) => s.snapshot.id === nextReg.snapshotId);
    const revisionLike = meta?.stage === 'correction' || meta?.stage === 'extension';
    const pb: Bound = revisionLike
      ? publishBound(calendar, meta?.publishClause ?? nextReg)
      : { cons: Number.NEGATIVE_INFINITY, opt: Number.NEGATIVE_INFINITY, wholeDay: false };
    if (pb.cons > prevEnd.cons) {
      invalid.push({
        kind: 'registration',
        from: { cons: prevEnd.cons, opt: prevEnd.opt, wholeDay: false },
        to: pb,
        reason: '更正发布晚于原报名截止，报名失效窗口',
        evidenceClauseIds: [prevReg.id, nextReg.id],
      });
    }
    if (nextReg.role === 'current' && nextEnd.cons < prevEnd.cons) {
      shortened.push({
        kind: 'registration',
        from: nextEnd,
        to: prevEnd,
        replacedBySnapshotId: nextReg.snapshotId,
        evidenceClauseIds: [prevReg.id, nextReg.id],
        reasons: [`报名截止由 ${prevReg.date} 提前至 ${nextReg.date}`, '被缩短的报名区段单独留痕'],
      });
    }
  }

  if (hasDateOnly && intervals.some((iv) => iv.status === 'available')) {
    exclusions.push({
      code: 'date-only-precision',
      message: '部分时间条款仅精确到日期，窗口按区域保守边界给出范围而非单点',
      excludesFromStats: false,
    });
  }

  // 项目终止：终止前已获得的时间仍是有效可用时长，只把区间截断到终止时刻；
  // 终止后不再产生新的可用区间。若整个窗口都在终止之后，则标记为已关闭、不计入。
  if (cancelledAt !== null) {
    const clamped: Interval[] = [];
    for (const iv of intervals) {
      if (iv.to.cons <= cancelledAt) {
        clamped.push(iv);
        continue;
      }
      if (iv.from.cons >= cancelledAt) {
        clamped.push({
          ...iv,
          from: { cons: cancelledAt, opt: cancelledAt, wholeDay: false },
          to: { cons: cancelledAt, opt: cancelledAt, wholeDay: false },
          status: 'closed',
          reasons: [...iv.reasons, `项目于 ${utcToLocal(cancelledAt, calendar.offsetMinutes).date} 终止，此后无可用窗口`],
        });
        continue;
      }
      const truncated: Interval = {
        ...iv,
        to: { cons: cancelledAt, opt: cancelledAt, wholeDay: false },
      };
      truncated.reasons = [
        ...truncated.reasons,
        `项目于 ${utcToLocal(cancelledAt, calendar.offsetMinutes).date} 终止，窗口提前关闭（终止前时长仍计入）`,
      ];
      clamped.push(truncated);
    }
    intervals.length = 0;
    intervals.push(...clamped);
  }

  return {
    intervals,
    shortened,
    invalid,
    currentDeadline: versions.length ? versions[versions.length - 1].deadline : null,
    currentRegistration: regByDate[regByDate.length - 1] ?? null,
    startClause,
    exclusions,
    cancelledAt,
  };
}

function dateKey(c: TimeClause): string {
  return `${c.date} ${c.time ?? '00:00'}`;
}

// ---------- 两种策略：物化区间聚合 / 按查询即时推演 ----------

function aggregateIntervals(intervals: Interval[], calendar: RegionCalendar | null): { segments: WindowSegment[]; effectiveMinutes: { min: number; max: number }; effectiveDays: { min: number; max: number } } {
  const segments: WindowSegment[] = [];
  let minM = 0;
  let maxM = 0;
  let minD = 0;
  let maxD = 0;

  for (const iv of intervals) {
    if (!calendar) {
      // 无法确定时区：UTC 范围按全球时区跨度（UTC-12 … UTC+14）展开，不参与统计
      const fromWallMs = iv.from.cons;
      const toWallMs = iv.to.cons;
      segments.push({
        fromUtc: fromWallMs - 14 * 60 * 60 * 1000,
        toUtc: toWallMs + 14 * 60 * 60 * 1000,
        fromUtcEarliest: fromWallMs - 14 * 60 * 60 * 1000,
        toUtcLatest: toWallMs + 14 * 60 * 60 * 1000,
        naturalDays: naturalRange(iv.from, iv.to),
        workMinutes: { min: 0, max: 0 },
        status: 'undetermined',
        versionSnapshotId: iv.versionSnapshotId,
        evidenceClauseIds: iv.evidenceClauseIds,
        reasons: [...iv.reasons, '区域日历未知，无法计算可用工作时长'],
      });
      continue;
    }
    if (iv.status === 'available' && iv.to.cons <= iv.from.cons) {
      // 截止早于起点：不产生可用区间，避免负/零长度片段进入证据
      segments.push({
        fromUtc: iv.from.cons,
        toUtc: iv.from.cons,
        fromUtcEarliest: iv.from.opt,
        toUtcLatest: iv.from.opt,
        naturalDays: { min: 0, max: 0 },
        workMinutes: { min: 0, max: 0 },
        status: 'closed',
        versionSnapshotId: iv.versionSnapshotId,
        evidenceClauseIds: iv.evidenceClauseIds,
        reasons: [...iv.reasons, '截止早于起点，该版本未形成可用区间'],
      });
      continue;
    }
    const work = minutesRange(calendar, iv.from, iv.to);
    const days = naturalRange(iv.from, iv.to);
    const status =
      iv.status === 'gap' ? 'gap' : iv.status === 'available' ? 'available' : iv.status === 'undetermined' ? 'undetermined' : 'closed';
    segments.push({
      fromUtc: iv.from.cons,
      toUtc: iv.to.cons,
      fromUtcEarliest: iv.from.opt,
      toUtcLatest: iv.to.opt,
      naturalDays: days,
      workMinutes: work,
      status,
      versionSnapshotId: iv.versionSnapshotId,
      evidenceClauseIds: iv.evidenceClauseIds,
      reasons: iv.reasons,
    });
    if (status === 'available') {
      minM += work.min;
      maxM += work.max;
      minD += days.min;
      maxD += days.max;
    }
  }
  return {
    segments,
    effectiveMinutes: { min: round2(minM), max: round2(maxM) },
    effectiveDays: { min: round2(minD), max: round2(maxD) },
  };
}

export interface LotWindowResult extends LotWindow {
  /** 该策略用于一致性对照的中间产物 */
  materializedIntervals?: number;
}

export function computeLotWindow(ctx: LotContext, calendar: RegionCalendar | null, opts: WindowComputeOptions): LotWindowResult {
  const timeline = buildTimeline(ctx, calendar);

  // 物化策略：先把区间固化为不可变片段（此处返回数量），发布时汇总；
  // 即时策略：每次查询重走事件序列并当场聚合。两者对同一输入必须得到相同时长。
  let materializedIntervals: number | undefined;
  const intervals = opts.strategy === 'materialized'
    ? timeline.intervals.map((iv) => ({ ...iv, reasons: [...iv.reasons] })) // 冻结副本
    : timeline.intervals; // 即时推演，不物化
  if (opts.strategy === 'materialized') materializedIntervals = intervals.length;

  const agg = aggregateIntervals(intervals, calendar);
  const scale = scaleOf(ctx.lotBudget ?? ctx.projectBudget);

  const evidence = ctx.clauses
    .filter((c) => relevantClauses([c], ctx.lotCode).length > 0)
    .map((c) => ({
      clauseId: c.id,
      snapshotId: c.snapshotId,
      kind: c.kind,
      label: c.label,
      text: c.evidence.text,
      start: c.evidence.start,
      end: c.evidence.end,
    }));

  const timeZoneUncertainty = calendar
    ? null
    : {
        undetermined: true,
        offsetRangeMinutes: [-720, 840] as [number, number],
        utcRange: agg.segments.length
          ? ([Math.min(...agg.segments.map((s) => s.fromUtc)), Math.max(...agg.segments.map((s) => s.toUtc))] as [number, number])
          : null,
      };

  return {
    projectCode: ctx.projectCode,
    lotCode: ctx.lotCode,
    lotName: ctx.lotName,
    regionId: ctx.regionId,
    regionName: calendar?.regionName ?? (ctx.regionId === 'UNKNOWN' ? '未知区域' : ctx.regionId),
    timeZone: calendar?.timeZone ?? '未知',
    offsetMinutes: calendar?.offsetMinutes ?? 0,
    procurementMethod: ctx.method,
    scaleBucket: scale.bucket,
    scaleBasis: scale.basis,
    calendarVersion: calendar?.version ?? null,
    clauses: ctx.clauses,
    segments: agg.segments,
    effectiveWorkMinutes: agg.effectiveMinutes,
    effectiveNaturalDays: agg.effectiveDays,
    shortenedIntervals: timeline.shortened.map((s) => ({
      kind: s.kind,
      fromUtc: s.from.cons,
      toUtc: s.to.cons,
      workMinutes: calendar ? minutesRange(calendar, s.from, s.to) : { min: 0, max: 0 },
      naturalDays: naturalRange(s.from, s.to),
      replacedBySnapshotId: s.replacedBySnapshotId,
      reasons: s.reasons,
      evidenceClauseIds: s.evidenceClauseIds,
    })),
    invalidVisibleWindows: timeline.invalid.map((v) => ({
      kind: v.kind,
      fromUtc: v.from.cons,
      toUtc: v.to.cons,
      naturalDays: round2(Math.max(0, v.to.cons - v.from.cons) / DAY_MS),
      reason: v.reason,
      evidenceClauseIds: v.evidenceClauseIds,
    })),
    timeZoneUncertainty,
    exclusions: timeline.exclusions,
    evidence,
    materializedIntervals,
  };
}

// ---------- 分组：从快照与事实构建标段上下文 ----------

interface BuildInput {
  snapshots: Snapshot[];
  facts: Fact[];
  registry: CalendarRegistry;
  cutoffAt: number;
}

function snapshotMeta(
  snapshot: Snapshot,
  facts: Fact[],
  clauses: TimeClause[],
  calendar: RegionCalendar | null,
): SnapshotMeta {
  const mine = facts.filter((f) => f.snapshotId === snapshot.id);
  const codeFact = mine.find((f) => f.type === 'project_code');
  const amountFacts = mine.filter((f) => f.type === 'amount' && typeof f.amountCny === 'number');
  const stageFact = mine.find((f) => f.type === 'stage' && f.stage);
  const regionId = inferRegion(snapshot);
  const publishClause = clauses.find((c) => c.kind === 'publish' && c.role === 'current');
  const publishAt = publishClause
    ? localToUtc(publishClause.date, publishClause.time, calendar?.offsetMinutes ?? 0).from
    : null;
  return {
    snapshot,
    projectCode: normalizeCode(codeFact?.value ?? projectCodeOf(snapshot) ?? ''),
    regionId,
    method: inferProcurementMethod(snapshot.rawText),
    stage: stageFact?.stage ?? null,
    publishAt,
    publishClause: publishClause ?? null,
    amountCny: amountFacts.length ? Math.max(...amountFacts.map((f) => f.amountCny!)) : null,
  };
}

export interface BuiltContexts {
  contexts: LotContext[];
  calendars: Map<string, RegionCalendar>;
  clausesBySnapshot: Map<string, TimeClause[]>;
  metas: SnapshotMeta[];
}

export function buildLotContexts(input: BuildInput): BuiltContexts {
  const { snapshots, facts, registry, cutoffAt } = input;
  const clausesBySnapshot = new Map<string, TimeClause[]>();
  for (const s of snapshots) clausesBySnapshot.set(s.id, extractAllTimeClauses([s]));

  // 日历按截止点取版本（历史分析不回填新版本）；先确定日历，再用区域偏移换算发布时刻
  const calendars = new Map<string, RegionCalendar>();
  for (const s of snapshots) {
    const regionId = inferRegion(s);
    if (regionId === 'UNKNOWN' || calendars.has(regionId)) continue;
    const cal = registry.asOf(regionId, cutoffAt);
    if (cal) calendars.set(regionId, cal);
  }
  const metas = snapshots.map((s) => {
    const clauses = clausesBySnapshot.get(s.id) ?? [];
    const regionId = inferRegion(s);
    return snapshotMeta(s, facts, clauses, calendars.get(regionId) ?? null);
  });

  // 项目分组：按规范化项目编号。无编号的快照自成组（按快照 id）
  const groups = new Map<string, SnapshotMeta[]>();
  for (const meta of metas) {
    const key = meta.projectCode || `__nos_${meta.snapshot.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(meta);
  }

  const contexts: LotContext[] = [];
  for (const [projectCode, members] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const usableCode = projectCode.startsWith('__nos_') ? '' : projectCode;
    const memberIds = new Set(members.map((m) => m.snapshot.id));
    const groupFacts = facts.filter((f) => memberIds.has(f.snapshotId));
    const lotFacts = groupFacts.filter((f) => f.type === 'lot' && f.lotCode);
    const clauses = members.flatMap((m) => clausesBySnapshot.get(m.snapshot.id) ?? []);

    const regionCounts = new Map<string, number>();
    for (const m of members) regionCounts.set(m.regionId, (regionCounts.get(m.regionId) ?? 0) + 1);
    const regionId = [...regionCounts.entries()]
      .filter(([r]) => r !== 'UNKNOWN')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'UNKNOWN';

    const methods = members.map((m) => m.method).filter((x): x is string => !!x);
    const method = methods.sort((a, b) => methods.filter((x) => x === b).length - methods.filter((x) => x === a).length || a.localeCompare(b))[0] ?? '未注明';

    const projectBudget = members.map((m) => m.amountCny).filter((x): x is number => x !== null);
    const projectBudgetMax = projectBudget.length ? Math.max(...projectBudget) : null;

    // 标段集合：来自标段事实；若一条都没有则用“全项目”伪标段
    const lotMap = new Map<string, { name: string; budget: number | null }>();
    for (const f of lotFacts) {
      if (!lotMap.has(f.lotCode!)) lotMap.set(f.lotCode!, { name: f.value, budget: null });
    }
    // 单标段快照可把金额归到该标段
    for (const m of members) {
      const mine = facts.filter((f) => f.snapshotId === m.snapshot.id);
      const lots = mine.filter((f) => f.type === 'lot' && f.lotCode);
      const amounts = mine.filter((f) => f.type === 'amount');
      if (lots.length === 1 && amounts.length) {
        const entry = lotMap.get(lots[0].lotCode!);
        if (entry) entry.budget = Math.max(...amounts.map((a) => a.amountCny!));
      }
    }

    if (lotMap.size === 0) {
      contexts.push({
        projectCode: usableCode,
        lotCode: '__ALL__',
        lotName: '全项目（未拆分标段）',
        regionId,
        method,
        projectBudget: projectBudgetMax,
        lotBudget: projectBudgetMax,
        clauses,
        snapshots: [...members].sort((a, b) => a.snapshot.id.localeCompare(b.snapshot.id)),
      });
      continue;
    }

    for (const [lotCode, info] of [...lotMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      contexts.push({
        projectCode: usableCode,
        lotCode,
        lotName: info.name,
        regionId,
        method,
        projectBudget: projectBudgetMax,
        lotBudget: info.budget,
        clauses,
        snapshots: [...members].sort((a, b) => a.snapshot.id.localeCompare(b.snapshot.id)),
      });
    }
  }

  return { contexts, calendars, clausesBySnapshot, metas };
}
