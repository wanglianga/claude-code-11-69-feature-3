/**
 * 分析发布器：按地区、采购方式和标段规模输出窗口分布与排除原因，
 * 不代替法定合规裁决（只做量化描述与留痕）。
 *
 * 发布时固定所用日历版本；历史发布继续引用原版本，新版日历另建差异结果。
 */
import type {
  Fact,
  PublicationStats,
  Snapshot,
  WindowAnalysis,
  WindowDistributionRow,
  WindowExclusionCode,
} from './types';
import { CalendarRegistry, calendarsAsOf } from './calendar';
import type { RegionCalendar } from './calendar';
import { buildLotContexts, computeLotWindow, WINDOW_ENGINE_VERSION, type LotWindowResult } from './windows';
import { deterministicId, stableStringify, sha256Hex } from './hash';
import { TIME_EXTRACTOR_VERSION } from './timeClauses';

export interface WindowPublishInput {
  snapshots: Snapshot[];
  facts: Fact[];
  registry: CalendarRegistry;
  /** 日历截止点；null 表示使用当前最新版本（发布此刻） */
  calendarCutoffAt: number | null;
  now: number;
  strategy: 'materialized' | 'on_demand';
  previous?: WindowAnalysis | null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function midpoint(r: { min: number; max: number }): number {
  return (r.min + r.max) / 2;
}

export async function publishWindowAnalysis(input: WindowPublishInput): Promise<WindowAnalysis> {
  const { snapshots, facts, registry, strategy, now } = input;
  const cutoffAt = input.calendarCutoffAt ?? now;

  const built = buildLotContexts({ snapshots, facts, registry, cutoffAt });
  const results: LotWindowResult[] = built.contexts.map((ctx) =>
    computeLotWindow(ctx, built.calendars.get(ctx.regionId) ?? null, { strategy, calendarCutoffAt: cutoffAt }),
  );

  // 分布：地区 × 采购方式 × 规模档
  const buckets = new Map<string, { row: WindowDistributionRow; hours: number[] }>();
  const exclusions: WindowAnalysis['exclusions'] = [];
  const exclusionByCode = new Map<WindowExclusionCode, string[]>();

  for (const lot of results) {
    const excluded = lot.exclusions.some((e) => e.excludesFromStats);
    const key = `${lot.regionId}|${lot.procurementMethod}|${lot.scaleBucket}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        row: {
          regionId: lot.regionId,
          regionName: lot.regionName,
          procurementMethod: lot.procurementMethod,
          scaleBucket: lot.scaleBucket,
          lotCount: 0,
          hoursMin: 0,
          hoursMedian: 0,
          hoursMax: 0,
          excludedCount: 0,
        },
        hours: [],
      });
    }
    const b = buckets.get(key)!;
    if (excluded) {
      b.row.excludedCount += 1;
    } else {
      b.row.lotCount += 1;
      b.hours.push(midpoint(lot.effectiveWorkMinutes) / 60);
    }
    for (const e of lot.exclusions) {
      if (!exclusionByCode.has(e.code)) exclusionByCode.set(e.code, []);
      const label = lot.projectCode ? `${lot.projectCode}/${lot.lotCode}` : lot.lotCode;
      if (!exclusionByCode.get(e.code)!.includes(label)) exclusionByCode.get(e.code)!.push(label);
    }
  }

  // 仅输出存在可判定标段的分桶；全部被排除的分组只出现在 exclusions 明细中
  const distributions = [...buckets.values()]
    .filter(({ row }) => row.lotCount > 0)
    .map(({ row, hours }) => ({
      ...row,
      hoursMin: hours.length ? round2(Math.min(...hours)) : 0,
      hoursMedian: round2(median(hours)),
      hoursMax: hours.length ? round2(Math.max(...hours)) : 0,
    }))
    .sort(
      (a, b) =>
        a.regionId.localeCompare(b.regionId) ||
        a.procurementMethod.localeCompare(b.procurementMethod) ||
        a.scaleBucket.localeCompare(b.scaleBucket),
    );

  for (const [code, lots] of [...exclusionByCode.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    exclusions.push({ code, lotCount: lots.length, lots: lots.sort() });
  }

  // 日历版本固定：只记录本次分析实际使用、且截止点时刻有效的版本
  const usedRegions = new Set(results.map((l) => l.regionId));
  const effectiveCals = calendarsAsOf(registry, cutoffAt).filter((c) => usedRegions.has(c.regionId));
  const calendarVersions = effectiveCals.map((c) => ({
    regionId: c.regionId,
    regionName: c.regionName,
    version: c.version,
    publishedAt:
      registry.allVersions().find((v) => v.regionId === c.regionId && v.version === c.version)?.publishedAt ?? cutoffAt,
  }));

  const notes: string[] = [
    '本分析仅量化供应商实际可获得的投标准备时间，不构成法定合规裁决。',
    '日期精度不足的条款按区域预设保守边界输出工作时长范围（min..max），未假定全天可用。',
    '更正发布晚于原截止时保留实际可见的失效窗口，不将新截止倒填为全程可用。',
    `策略：${strategy === 'materialized' ? '物化不可变区间后汇总' : '保留事件序列、按查询截止点即时推演'}。`,
    `日历截止点 ${new Date(cutoffAt).toISOString()}；历史分析引用原日历版本，新版日历另建差异结果。`,
  ];

  const fingerprint = await sha256Hex(
    stableStringify({
      strategy,
      cutoffAt,
      lots: results.map((l) => ({
        p: l.projectCode,
        l: l.lotCode,
        w: l.effectiveWorkMinutes,
        d: l.effectiveNaturalDays,
        c: l.calendarVersion,
      })),
      calendarVersions,
    }),
  );

  const version = input.previous ? input.previous.version + 1 : 1;
  return {
    id: deterministicId('wpub', [fingerprint.slice(0, 16), version]),
    version,
    strategy,
    computedAt: now,
    calendarCutoffAt: cutoffAt,
    calendarVersions,
    lots: results.map(({ materializedIntervals: _m, ...rest }) => rest),
    distributions,
    exclusions,
    notes: [...notes, `引擎 ${WINDOW_ENGINE_VERSION} ／ 时间提取器 ${TIME_EXTRACTOR_VERSION}`],
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 统计辅助：窗口分析中参与统计的标段数与排除数 */
export function windowStats(analysis: WindowAnalysis): Pick<PublicationStats, 'lotCount'> & {
  excludedLotCount: number;
  determinedLotCount: number;
} {
  const excludedLotCount = analysis.lots.filter((l) => l.exclusions.some((e) => e.excludesFromStats)).length;
  return {
    lotCount: analysis.lots.length,
    excludedLotCount,
    determinedLotCount: analysis.lots.length - excludedLotCount,
  };
}

export type { RegionCalendar };

export interface WindowDiffRow {
  projectCode: string;
  lotCode: string;
  regionId: string;
  /** 两次分析引用的日历版本（按区域） */
  calendarVersionBefore: string | null;
  calendarVersionAfter: string | null;
  workMinutesBefore: { min: number; max: number } | null;
  workMinutesAfter: { min: number; max: number } | null;
  /** 差值（分钟，按区间中点计算）；新增/移除为 null */
  deltaMinutes: number | null;
  status: 'changed' | 'unchanged' | 'added' | 'removed';
}

/**
 * 两个窗口分析之间的差异（通常用于“日历在历史日期后更正 → 新版另建结果”）。
 * 只比较有效工作时长与日历版本，输出可直接阅读的差异行。
 */
export function diffWindowAnalyses(before: WindowAnalysis, after: WindowAnalysis): WindowDiffRow[] {
  const key = (p: string, l: string) => `${p}|${l}`;
  const beforeMap = new Map(before.lots.map((l) => [key(l.projectCode, l.lotCode), l]));
  const afterMap = new Map(after.lots.map((l) => [key(l.projectCode, l.lotCode), l]));
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const calBefore = new Map(before.calendarVersions.map((c) => [c.regionId, c.version]));
  const calAfter = new Map(after.calendarVersions.map((c) => [c.regionId, c.version]));

  return keys.map((k) => {
    const b = beforeMap.get(k);
    const a = afterMap.get(k);
    const regionId = (a ?? b)!.regionId;
    const wb = b ? b.effectiveWorkMinutes : null;
    const wa = a ? a.effectiveWorkMinutes : null;
    const delta =
      wb && wa ? round2((wa.min + wa.max) / 2 - (wb.min + wb.max) / 2) : null;
    const status: WindowDiffRow['status'] = !b
      ? 'added'
      : !a
        ? 'removed'
        : delta !== 0 || calBefore.get(regionId) !== calAfter.get(regionId)
          ? 'changed'
          : 'unchanged';
    return {
      projectCode: (a ?? b)!.projectCode,
      lotCode: (a ?? b)!.lotCode,
      regionId,
      calendarVersionBefore: calBefore.get(regionId) ?? null,
      calendarVersionAfter: calAfter.get(regionId) ?? null,
      workMinutesBefore: wb,
      workMinutesAfter: wa,
      deltaMinutes: delta,
      status,
    };
  });
}
