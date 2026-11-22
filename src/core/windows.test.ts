/**
 * 标段有效投标窗口验收测试：
 * 覆盖区域日历（时区、周末、法定假日、临时调休、日历版本化）、
 * 时间条款提取证据、窗口切分（延长/提前/失效空档）、日期精度不足的保守范围、
 * 未知时区排除，以及物化/即时两种策略的等价性。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRepository } from './memoryRepository';
import { WorkbenchEngine, type ImportFileInput } from './engine';
import {
  calendarsAsOf,
  countWorkdays,
  defaultCalendarRegistry,
  isWorkday,
  localToUtc,
  workMinutesBetween,
} from './calendar';
import { extractTimeClauses, TIME_EXTRACTOR_VERSION } from './timeClauses';
import { publishWindowAnalysis } from './windowPublisher';
import type { Fact, Snapshot, WindowAnalysis } from './types';
import { parseDocument, inferSourceKind } from './parser';
import { sha256Hex } from './hash';

const SAMPLE_DIR = join(process.cwd(), 'sample-archive');
const WINDOW_DIR = join(process.cwd(), 'sample-windows');

/** 以 2024-12-31 为日历截止点，可覆盖示例中的全部历史日期与川西日历修订 */
const CUTOFF = Date.UTC(2024, 11, 31);

function loadWindowSamples(): ImportFileInput[] {
  return readdirSync(WINDOW_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((fileName) => ({ fileName, text: readFileSync(join(WINDOW_DIR, fileName), 'utf-8') }));
}

async function snapshotOf(file: ImportFileInput): Promise<Snapshot> {
  const contentHash = await sha256Hex(file.text);
  return {
    id: `snap_${file.fileName.slice(0, 3)}`,
    contentHash,
    normalizedHash: contentHash,
    rawText: file.text,
    sources: [{ fileName: file.fileName, batchId: 'window-batch', importedAt: 1, size: file.text.length }],
    parsed: parseDocument(file.text, inferSourceKind(file.fileName)),
    createdAt: 1,
  };
}

/** 只构造窗口分析需要的事实（编号、标段、金额、阶段），用于隔离窗口逻辑 */
async function factsFor(snapshot: Snapshot): Promise<Fact[]> {
  const facts: Fact[] = [];
  const base = { snapshotId: snapshot.id, sectionKind: 'announcement' as const, ruleVersion: 'test', extractorVersion: 'test' };
  const code = /(?:项目编号|采购编号)[：:]\s*([A-Za-z0-9][A-Za-z0-9\-_/]*[A-Za-z0-9])/.exec(snapshot.rawText);
  if (code) {
    facts.push({ ...base, id: `c_${snapshot.id}`, type: 'project_code', value: code[1], evidence: { start: 0, end: code[1].length, text: code[1] }, ruleId: 'R-CODE-01' });
  }
  for (const m of snapshot.rawText.matchAll(/(第[一二三四五六七八九十]标段)([：:][^\n]*)?/g)) {
    const name = (m[2] ?? '').replace(/^[：:]/, '').trim() || m[1];
    facts.push({ ...base, id: `l_${snapshot.id}_${m[1]}`, type: 'lot', value: name, lotCode: m[1], evidence: { start: 0, end: m[1].length, text: m[0] }, ruleId: 'R-LOT-01' });
  }
  for (const m of snapshot.rawText.matchAll(/预算金额[：:]\s*([0-9.]+)\s*万元/g)) {
    facts.push({ ...base, id: `a_${snapshot.id}`, type: 'amount', value: m[1], amountCny: Number(m[1]) * 10000, evidence: { start: 0, end: m[0].length, text: m[0] }, ruleId: 'R-AMT-01' });
  }
  const stage = /更正公告/.test(snapshot.rawText)
    ? 'correction'
    : /延期公告/.test(snapshot.rawText)
      ? 'extension'
      : /终止公告/.test(snapshot.rawText)
        ? 'cancellation'
        : /(招标公告|询价公告|磋商公告|采购公告)/.test(snapshot.rawText)
          ? 'announcement'
          : null;
  if (stage) {
    facts.push({ ...base, id: `s_${snapshot.id}`, type: 'stage', value: stage, stage: stage as Fact['stage'], evidence: { start: 0, end: stage.length, text: stage }, ruleId: 'R-STAGE-06' });
  }
  return facts;
}

async function buildWindowAnalysis(files: ImportFileInput[], strategy: 'materialized' | 'on_demand' = 'on_demand') {
  const snapshots = await Promise.all(files.map(snapshotOf));
  const facts = (await Promise.all(snapshots.map(factsFor))).flat();
  const registry = defaultCalendarRegistry();
  const analysis = await publishWindowAnalysis({
    snapshots, facts, registry, calendarCutoffAt: CUTOFF, now: CUTOFF, strategy,
  });
  return { analysis, registry, snapshots, facts };
}

function lotBy(analysis: WindowAnalysis, code: string, lotCode?: string) {
  return analysis.lots.find((l) => l.projectCode === code && (lotCode ? l.lotCode === lotCode : true));
}

describe('区域日历库', () => {
  it('周末、法定假日与临时调休共同决定工作日', () => {
    const cal = defaultCalendarRegistry().latest('GD')!;
    expect(isWorkday(cal, '2024-03-23')).toBe(false); // 周六
    expect(isWorkday(cal, '2024-04-04')).toBe(false); // 清明假日（周四）
    expect(isWorkday(cal, '2024-04-07')).toBe(true); // 周日调休上班
    expect(isWorkday(cal, '2024-05-11')).toBe(true); // 周六调休上班
  });

  it('可用工作时长扣除午休，并以区域本地时区换算', () => {
    const cal = defaultCalendarRegistry().latest('ZJ')!;
    expect(workMinutesBetween(cal, localToUtc('2024-03-25', '09:00', cal.offsetMinutes).from, localToUtc('2024-03-25', '17:00', cal.offsetMinutes).from)).toBe(390);
    const breakdown = countWorkdays(cal, localToUtc('2024-03-25', '09:00', 480).from, localToUtc('2024-04-01', '00:00', 480).from);
    // 3/25–3/29 五个工作日；3/30–3/31 周末；4/1 为端点（不计）
    expect(breakdown.workdays).toBe(5);
    expect(breakdown.weekendDays).toBe(2);
  });

  it('跨时区：四川示例区域按 UTC+6 结算', () => {
    const cal = defaultCalendarRegistry().latest('SC')!;
    expect(cal.timeZone).toBe('Asia/Urumqi');
    expect(cal.offsetMinutes).toBe(360);
    const local = localToUtc('2024-06-19', '10:00', cal.offsetMinutes);
    expect(new Date(local.from).toISOString()).toBe('2024-06-19T04:00:00.000Z');
  });

  it('日历版本化：历史日期后修订不回溯改变当时分析，新版另建结果', () => {
    const reg = defaultCalendarRegistry();
    const beforeRevision = calendarsAsOf(reg, Date.UTC(2024, 5, 15)).find((c) => c.regionId === 'SC')!;
    const afterRevision = calendarsAsOf(reg, CUTOFF).find((c) => c.regionId === 'SC')!;
    expect(beforeRevision.version).toBe('cal-2024.1');
    expect(afterRevision.version).toBe('cal-2024.2');
    expect(isWorkday(beforeRevision, '2024-06-17')).toBe(true); // 旧版本视其为普通周一
    expect(isWorkday(afterRevision, '2024-06-17')).toBe(false); // 新版本补充州庆假日
    // 同一历史分析若固定在修订前截止点，仍引用旧版本
    expect(reg.asOf('SC', Date.UTC(2024, 5, 15))!.version).toBe('cal-2024.1');
  });

  it('区域日历版本写入仓储后可原样恢复（追加式、不可变）', async () => {
    const repo = new MemoryRepository();
    const engine = new WorkbenchEngine(repo, undefined, () => CUTOFF);
    const first = await engine.loadCalendarRegistry();
    const second = await engine.loadCalendarRegistry();
    expect(first.allVersions().length).toBe(second.allVersions().length);
    expect(await repo.getAllCalendarVersions()).toHaveLength(first.allVersions().length);
  });
});

describe('时间条款提取器', () => {
  it('保留六类时间条款及其字符级原文证据', () => {
    const file = loadWindowSamples().find((f) => f.fileName.startsWith('W01'))!;
    const snapshot = {
      id: 'snap_w01',
      sources: [{ fileName: file.fileName, batchId: 'b', importedAt: 1, size: file.text.length }],
      rawText: file.text,
      parsed: parseDocument(file.text, inferSourceKind(file.fileName)),
    } as Snapshot;
    const clauses = extractTimeClauses(snapshot);
    const kinds = new Set(clauses.map((c) => c.kind));
    for (const k of ['publish', 'download', 'registration', 'clarify', 'submission', 'opening'] as const) {
      expect(kinds.has(k)).toBe(true);
    }
    for (const c of clauses) {
      expect(file.text.slice(c.evidence.start, c.evidence.end)).toBe(c.evidence.text);
      expect(c.ruleVersion).toBe(TIME_EXTRACTOR_VERSION);
    }
    // 仅日期条款的精度必须标记为 date，不能伪造时刻
    const submission = clauses.find((c) => c.kind === 'submission')!;
    expect(submission.precision).toBe('date');
    expect(submission.time).toBeNull();
  });

  it('“原…现调整至…”保留被替换的历史值并与现行值区分', () => {
    const file = loadWindowSamples().find((f) => f.fileName.startsWith('W02'))!;
    const snapshot = {
      id: 'snap_w02',
      sources: [{ fileName: file.fileName, batchId: 'b', importedAt: 1, size: file.text.length }],
      rawText: file.text,
      parsed: parseDocument(file.text, inferSourceKind(file.fileName)),
    } as Snapshot;
    const clauses = extractTimeClauses(snapshot).filter((c) => c.kind === 'submission');
    const ref = clauses.find((c) => c.role === 'reference')!;
    const cur = clauses.find((c) => c.role === 'current')!;
    expect(ref.date).toBe('2024-04-08');
    expect(cur.date).toBe('2024-04-03');
    expect(cur.time).toBe('17:00');
  });

  it('按标段收窄时间条款：不同标段可有不同截止', () => {
    const file = loadWindowSamples().find((f) => f.fileName.startsWith('W03'))!;
    const snapshot = {
      id: 'snap_w03',
      sources: [{ fileName: file.fileName, batchId: 'b', importedAt: 1, size: file.text.length }],
      rawText: file.text,
      parsed: parseDocument(file.text, inferSourceKind(file.fileName)),
    } as Snapshot;
    const subs = extractTimeClauses(snapshot).filter((c) => c.kind === 'submission');
    expect(subs.find((c) => c.lotCode === '第一标段')?.date).toBe('2024-06-19');
    expect(subs.find((c) => c.lotCode === '第二标段')?.date).toBe('2024-06-20');
  });
});

describe('窗口演算器', () => {
  it('仅日期截止按保守边界给范围，不假定全天可用', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W01') || f.fileName.startsWith('W02'));
    const { analysis, registry } = await buildWindowAnalysis(files);
    const lot = lotBy(analysis, 'GD2024-KJ-118')!;
    expect(lot).toBeTruthy();
    expect(lot.regionId).toBe('GD');
    expect(lot.effectiveWorkMinutes.min).toBeLessThan(lot.effectiveWorkMinutes.max);
    expect(lot.effectiveWorkMinutes.min).toBeGreaterThan(0);
    expect(lot.exclusions.some((e) => e.code === 'date-only-precision' && !e.excludesFromStats)).toBe(true);
    // 保守边界：日期精度不足时，截止日当天保守计 0 分钟、乐观计一个工作日，
    // 差值恰为一个工作日（390 分钟），而不是把整天 24 小时都当作可用。
    const cal = registry.latest('GD')!;
    const oneWorkday = workMinutesBetween(
      cal,
      localToUtc('2024-04-03', '00:00', 480).from,
      localToUtc('2024-04-03', '17:00', 480).from,
    );
    expect(oneWorkday).toBe(390);
    expect(lot.effectiveWorkMinutes.max - lot.effectiveWorkMinutes.min).toBeCloseTo(390, 5);
    expect(lot.effectiveWorkMinutes.max - lot.effectiveWorkMinutes.min).toBeLessThan(24 * 60);
  });

  it('周末发布：窗口起点按周一可下载时间起算，且不把周末算作工作时段', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W01') || f.fileName.startsWith('W02'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot = lotBy(analysis, 'GD2024-KJ-118')!;
    // 公告 2024-03-23 为周六；首个可下载节点为 3/25（周一）
    const first = lot.segments.find((s) => s.status === 'available')!;
    expect(new Date(first.fromUtc).toISOString()).toBe('2024-03-25T09:00:00.000Z');
    const evidence = lot.evidence.find((e) => e.kind === 'publish')!;
    expect(evidence.text).toContain('2024年3月23日');
  });

  it('截止被更正提前：输出被缩短区间及证据', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W01') || f.fileName.startsWith('W02'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot = lotBy(analysis, 'GD2024-KJ-118')!;
    expect(lot.shortenedIntervals).toHaveLength(1);
    const shortened = lot.shortenedIntervals[0];
    expect(shortened.kind).toBe('submission');
    // 被缩短区间从新截止 4/3 17:00 到原截止所在日边界
    expect(new Date(shortened.fromUtc).toISOString()).toBe('2024-04-03T09:00:00.000Z');
    expect(shortened.workMinutes.min).toBeGreaterThan(0);
    expect(shortened.evidenceClauseIds).toHaveLength(2);
  });

  it('更正发布晚于原截止：保留实际可见的失效窗口，不倒填新截止', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W03') || f.fileName.startsWith('W04'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot1 = lotBy(analysis, 'SC2024-WZ-306', '第一标段')!;
    expect(lot1.invalidVisibleWindows).toHaveLength(1);
    const gap = lot1.invalidVisibleWindows[0];
    expect(gap.kind).toBe('submission');
    expect(gap.naturalDays).toBeGreaterThan(0);
    // 失效空档起点 = 原截止 6/19 10:00（UTC+6 → 04:00Z）
    expect(new Date(gap.fromUtc).toISOString()).toBe('2024-06-19T04:00:00.000Z');
    // 存在 gap 段，且 gap 不计入有效工时
    expect(lot1.segments.some((s) => s.status === 'gap')).toBe(true);
    const effective = lot1.segments.filter((s) => s.status === 'available');
    // 延期后的可用段从更正发布时刻之后才开始
    const reopened = effective[effective.length - 1];
    expect(reopened.fromUtc).toBeGreaterThanOrEqual(gap.toUtc);
  });

  it('跨时区与临时调休：川西按 UTC+6 结算，州庆假日与调休生效', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W03') || f.fileName.startsWith('W04'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot1 = lotBy(analysis, 'SC2024-WZ-306', '第一标段')!;
    expect(lot1.timeZone).toBe('Asia/Urumqi');
    expect(lot1.offsetMinutes).toBe(360);
    expect(lot1.calendarVersion).toBe('cal-2024.2');
    // 6/17 州庆假日不计入工时；6/8 调休上班计入
    expect(lot1.segments.some((s) => s.status !== 'undetermined')).toBe(true);
    const cal = defaultCalendarRegistry().latest('SC')!;
    expect(isWorkday(cal, '2024-06-17')).toBe(false);
    expect(isWorkday(cal, '2024-06-08')).toBe(true);
  });

  it('两个标段的窗口彼此独立：第二标段截止更晚，有效工时更长', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W03') || f.fileName.startsWith('W04'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot1 = lotBy(analysis, 'SC2024-WZ-306', '第一标段')!;
    const lot2 = lotBy(analysis, 'SC2024-WZ-306', '第二标段')!;
    expect(lot2.effectiveWorkMinutes.min).toBeGreaterThan(lot1.effectiveWorkMinutes.min);
    expect(lot2.invalidVisibleWindows).toHaveLength(1);
  });

  it('报名截止更正晚于原报名截止：保留报名失效窗口', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W05') || f.fileName.startsWith('W06'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot = lotBy(analysis, 'HF2024-XM-083')!;
    const reg = lot.invalidVisibleWindows.find((v) => v.kind === 'registration')!;
    expect(reg).toBeTruthy();
    expect(new Date(reg.fromUtc).toISOString()).toBe('2024-09-18T09:00:00.000Z'); // 17:00 +08:00
    // 由于 9/18 为调休上班日（周六），报名失效窗口跨越该工作日
    expect(reg.naturalDays).toBeGreaterThan(0);
  });

  it('未知区域无法确定时区：标记排除且不计入统计', async () => {
    const files = loadWindowSamples();
    const { analysis } = await buildWindowAnalysis(files);
    const lot = lotBy(analysis, 'XJ2024-TS-009')!;
    expect(lot.calendarVersion).toBeNull();
    expect(lot.timeZoneUncertainty?.undetermined).toBe(true);
    expect(lot.exclusions.some((e) => e.code === 'timezone-undetermined' && e.excludesFromStats)).toBe(true);
    expect(lot.exclusions.some((e) => e.code === 'unknown-region-calendar' && e.excludesFromStats)).toBe(true);
    // 仍给出跨全球时区的 UTC 不确定范围，便于说明无法确定的原因
    expect(lot.segments.some((s) => s.status === 'undetermined')).toBe(true);
    expect(lot.timeZoneUncertainty!.utcRange).not.toBeNull();
    expect(lot.effectiveWorkMinutes).toEqual({ min: 0, max: 0 });
    expect(analysis.distributions.some((d) => d.regionId === 'UNKNOWN')).toBe(false);
    expect(analysis.exclusions.find((e) => e.code === 'timezone-undetermined')!.lotCount).toBeGreaterThanOrEqual(1);
  });

  it('分析发布器按地区、采购方式与规模分桶，且逐标段证据可回溯原文', async () => {
    const files = loadWindowSamples();
    const { analysis, snapshots } = await buildWindowAnalysis(files);
    expect(analysis.distributions.length).toBeGreaterThanOrEqual(3);
    const scRow = analysis.distributions.find((d) => d.regionId === 'SC')!;
    expect(scRow.procurementMethod).toBe('公开招标');
    expect(scRow.scaleBucket).toBe('大型');
    expect(scRow.lotCount).toBe(2);
    expect(scRow.hoursMedian).toBeGreaterThan(0);

    const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
    for (const lot of analysis.lots) {
      for (const clause of lot.clauses) {
        const snap = snapshotById.get(clause.snapshotId)!;
        expect(snap.rawText.slice(clause.evidence.start, clause.evidence.end)).toBe(clause.evidence.text);
      }
    }
  });

  it('两种策略（物化区间 / 即时推演）产生相同有效时长与逐时段证据', async () => {
    const files = loadWindowSamples();
    const materialized = await buildWindowAnalysis(files, 'materialized');
    const onDemand = await buildWindowAnalysis(files, 'on_demand');
    const key = (a: WindowAnalysis) =>
      a.lots.map((l) => ({
        p: l.projectCode, l: l.lotCode,
        w: l.effectiveWorkMinutes, d: l.effectiveNaturalDays,
        seg: l.segments.map((s) => [s.fromUtc, s.toUtc, s.status, s.workMinutes]),
        short: l.shortenedIntervals.map((s) => [s.kind, s.fromUtc, s.toUtc]),
        invalid: l.invalidVisibleWindows.map((s) => [s.kind, s.fromUtc, s.toUtc]),
      }));
    expect(key(materialized.analysis)).toEqual(key(onDemand.analysis));
    expect(materialized.analysis.strategy).toBe('materialized');
    expect(onDemand.analysis.strategy).toBe('on_demand');
  });

  it('日历截止点不同：同一历史分析引用不同日历版本并另建结果', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W03') || f.fileName.startsWith('W04'));
    const snapshots = await Promise.all(files.map(snapshotOf));
    const facts = (await Promise.all(snapshots.map(factsFor))).flat();
    const registry = defaultCalendarRegistry();
    const before = await publishWindowAnalysis({
      snapshots, facts, registry, calendarCutoffAt: Date.UTC(2024, 5, 15), now: Date.UTC(2024, 5, 15), strategy: 'on_demand',
    });
    const after = await publishWindowAnalysis({
      snapshots, facts, registry, calendarCutoffAt: CUTOFF, now: CUTOFF, strategy: 'on_demand',
    });
    expect(before.calendarVersions.find((c) => c.regionId === 'SC')!.version).toBe('cal-2024.1');
    expect(after.calendarVersions.find((c) => c.regionId === 'SC')!.version).toBe('cal-2024.2');
    expect(before.id).not.toBe(after.id);
    // 历史分析工时不受追溯修订影响；新版把 6/17 州庆扣除后应恰好少一个工作日（390 分钟）
    const lotBefore = before.lots.find((l) => l.lotCode === '第一标段')!;
    const lotAfter = after.lots.find((l) => l.lotCode === '第一标段')!;
    expect(lotBefore.calendarVersion).toBe('cal-2024.1');
    expect(lotAfter.calendarVersion).toBe('cal-2024.2');
    expect(lotBefore.effectiveWorkMinutes.min - lotAfter.effectiveWorkMinutes.min).toBeCloseTo(390, 5);
    expect(lotBefore.effectiveWorkMinutes.max - lotAfter.effectiveWorkMinutes.max).toBeCloseTo(390, 5);
  });
});

describe('与既有归档流水线的集成', () => {
  it('导入 12 份主示例并发布窗口：浙江延期计入有效窗口，安徽仅有终止不形成窗口', async () => {
    const repo = new MemoryRepository();
    const engine = new WorkbenchEngine(repo, undefined, () => CUTOFF);
    const files = readdirSync(SAMPLE_DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((fileName) => ({ fileName, text: readFileSync(join(SAMPLE_DIR, fileName), 'utf-8') }));
    await engine.importBatch('窗口集成', files);
    await engine.recomputeAndPublish('full');
    const analysis = await engine.publishWindows({ strategy: 'on_demand' });
    const zj = analysis.lots.filter((l) => l.projectCode === 'ZC2024-017');
    expect(zj.length).toBeGreaterThanOrEqual(1);
    const zjValid = zj.filter((l) => !l.exclusions.some((e) => e.excludesFromStats));
    expect(zjValid.length).toBeGreaterThanOrEqual(1);
    expect(zjValid[0].effectiveWorkMinutes.min).toBeGreaterThan(0);
    // 延期：由 4/18 至 4/28，延期发布早于原截止 → 续接而非失效
    expect(zjValid[0].invalidVisibleWindows.filter((v) => v.kind === 'submission')).toHaveLength(0);

    // 安徽原项目被终止：终止公告不含递交截止条款，不应形成可用窗口
    const hfCancelled = analysis.lots.filter((l) => l.projectCode === 'HF2024-XM-082');
    expect(hfCancelled.length).toBeGreaterThanOrEqual(1);
    for (const lot of hfCancelled) {
      expect(lot.exclusions.some((e) => e.excludesFromStats)).toBe(true);
      expect(lot.effectiveWorkMinutes.min).toBe(0);
    }
    // 重新采购公告（HF2024-XM-082-2）含递交截止，可作为独立标段形成窗口
    const hfRestart = analysis.lots.filter((l) => l.projectCode === 'HF2024-XM-082-2');
    expect(hfRestart.length).toBeGreaterThanOrEqual(1);
  });

  it('引擎双策略一致性校验通过，且分析持久化后可读取', async () => {
    const repo = new MemoryRepository();
    const engine = new WorkbenchEngine(repo, undefined, () => CUTOFF);
    await engine.importBatch('窗口校验', loadWindowSamples());
    await engine.recomputeAndPublish('full');
    const report = await engine.checkWindowStrategies();
    expect(report.equal).toBe(true);
    expect(report.diffs).toEqual([]);
    const published = await engine.publishWindows({ strategy: 'on_demand' });
    const latest = await repo.getLatestWindowAnalysis();
    expect(latest!.id).toBe(published.id);
    expect(latest!.version).toBe(1);
    // 第二次发布产生新版本，历史版本仍可读取（历史解释直接）
    const second = await engine.publishWindows({ strategy: 'materialized' });
    expect(second.version).toBe(2);
    expect((await repo.getAllWindowAnalyses()).length).toBe(2);
  });
});

describe('窗口样例经真实提取器端到端', () => {
  it('真实事实提取（编号/标段/金额/阶段）即可驱动窗口分析', async () => {
    const repo = new MemoryRepository();
    const engine = new WorkbenchEngine(repo, undefined, () => CUTOFF);
    await engine.importBatch('窗口样例-真实提取', loadWindowSamples());
    await engine.recomputeAndPublish('full');
    const analysis = await engine.publishWindows({ strategy: 'on_demand' });

    const gd = lotBy(analysis, 'GD2024-KJ-118')!;
    expect(gd).toBeTruthy();
    expect(gd.procurementMethod).toBe('竞争性磋商');
    expect(gd.scaleBucket).toBe('小型');
    expect(gd.shortenedIntervals).toHaveLength(1);

    const sc1 = lotBy(analysis, 'SC2024-WZ-306', '第一标段')!;
    const sc2 = lotBy(analysis, 'SC2024-WZ-306', '第二标段')!;
    expect(sc1.offsetMinutes).toBe(360);
    expect(sc2.effectiveWorkMinutes.min).toBeGreaterThan(sc1.effectiveWorkMinutes.min);
    expect(sc1.invalidVisibleWindows).toHaveLength(1);

    const hf = lotBy(analysis, 'HF2024-XM-083')!;
    expect(hf.invalidVisibleWindows.some((v) => v.kind === 'registration')).toBe(true);

    const xj = lotBy(analysis, 'XJ2024-TS-009')!;
    expect(xj.exclusions.some((e) => e.excludesFromStats)).toBe(true);
  });

  it('改动的快照只影响自身标段窗口，未受影响标段窗口逐字段不变（增量友好）', async () => {
    const repo = new MemoryRepository();
    const engine = new WorkbenchEngine(repo, undefined, () => CUTOFF);
    const all = loadWindowSamples();
    await engine.importBatch('第一批', all.filter((f) => !f.fileName.startsWith('W02')));
    await engine.recomputeAndPublish('full');
    const before = await engine.publishWindows({ strategy: 'on_demand' });
    const scBefore = before.lots.filter((l) => l.projectCode === 'SC2024-WZ-306');

    await engine.importBatch('第二批-广东更正', all.filter((f) => f.fileName.startsWith('W02')));
    await engine.recomputeAndPublish('incremental');
    const after = await engine.publishWindows({ strategy: 'on_demand' });
    const scAfter = after.lots.filter((l) => l.projectCode === 'SC2024-WZ-306');
    expect(scAfter.map((l) => [l.lotCode, l.effectiveWorkMinutes, l.segments.length])).toEqual(
      scBefore.map((l) => [l.lotCode, l.effectiveWorkMinutes, l.segments.length]),
    );
    expect(after.version).toBe(2);
  });
});

describe('版本差异与排除原因', () => {
  it('不同日历截止点的两次发布可用差异对照定位变化标段', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W03') || f.fileName.startsWith('W04'));
    const snapshots = await Promise.all(files.map(snapshotOf));
    const facts = (await Promise.all(snapshots.map(factsFor))).flat();
    const registry = defaultCalendarRegistry();
    const { diffWindowAnalyses } = await import('./windowPublisher');
    const before = await publishWindowAnalysis({ snapshots, facts, registry, calendarCutoffAt: Date.UTC(2024, 5, 15), now: Date.UTC(2024, 5, 15), strategy: 'on_demand' });
    const after = await publishWindowAnalysis({ snapshots, facts, registry, calendarCutoffAt: CUTOFF, now: CUTOFF, strategy: 'on_demand' });
    const rows = diffWindowAnalyses(before, after);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.status).toBe('changed');
      expect(row.calendarVersionBefore).toBe('cal-2024.1');
      expect(row.calendarVersionAfter).toBe('cal-2024.2');
      expect(row.deltaMinutes).not.toBeNull();
      expect(row.deltaMinutes!).toBeLessThanOrEqual(0);
    }
  });

  it('全部被排除的标段只出现在排除明细，不进入分布', async () => {
    const files = loadWindowSamples();
    const { analysis } = await buildWindowAnalysis(files);
    const unknown = analysis.exclusions.find((e) => e.code === 'unknown-region-calendar')!;
    expect(unknown.lots).toContain('XJ2024-TS-009/第一标段');
    expect(analysis.distributions.every((d) => d.regionId !== 'UNKNOWN')).toBe(true);
    // 采购方式未注明的记录显式标出，而不是猜测
    expect(analysis.lots.some((l) => l.procurementMethod === '未注明')).toBe(false);
  });
});

describe('仅导入更正材料的鲁棒性', () => {
  it('缺少原公告时，更正公告自带的“原…”值仍可还原失效窗口', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W06'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot = analysis.lots.find((l) => l.projectCode === 'HF2024-XM-083')!;
    expect(lot).toBeTruthy();
    // 报名截止由 9/18 更正为 9/23，发布晚于原截止 → 报名失效窗口
    const inv = lot.invalidVisibleWindows.find((v) => v.kind === 'registration')!;
    expect(inv).toBeTruthy();
    expect(new Date(inv.fromUtc).toISOString()).toBe('2024-09-18T09:00:00.000Z');
    // 该回退路径不得把报名失效重复记为递交失效
    expect(lot.invalidVisibleWindows.filter((v) => v.kind === 'submission')).toHaveLength(0);
    // 窗口终点按报名截止处理，并显式标记缺少递交截止
    expect(lot.exclusions.some((e) => e.code === 'missing-submission-deadline')).toBe(true);
  });
});

describe('起点不得早于更正发布', () => {
  it('只导入广东更正公告：起点被钳制到更正发布时刻，不把发布前的时间计为可用', async () => {
    const files = loadWindowSamples().filter((f) => f.fileName.startsWith('W02'));
    const { analysis } = await buildWindowAnalysis(files);
    const lot = analysis.lots.find((l) => l.projectCode === 'GD2024-KJ-118')!;
    expect(lot).toBeTruthy();
    const available = lot.segments.filter((s) => s.status === 'available');
    expect(available).toHaveLength(1);
    // 更正公告 2024-03-29 发布（仅日期 → 保守取当日 17:00 北京时间 = 09:00Z），
    // 不得从 3/29 之前起算
    expect(available[0].fromUtc).toBeGreaterThanOrEqual(Date.UTC(2024, 2, 29, 9, 0));
  });
});

describe('项目终止', () => {
  it('终止前已获得的时间计入，终止后不再产生可用窗口', async () => {
    const announcement = readFileSync(join(WINDOW_DIR, 'W03-四川-跨时区-调休发布-SC2024-WZ-306.txt'), 'utf-8');
    const termination = [
      '当前位置：首页 > 终止公告 > 详情',
      '',
      '四川省应急管理厅应急通信指挥车采购项目终止公告',
      '',
      '项目编号：SC2024-WZ-306',
      '采购人：四川省应急管理厅物资储备中心',
      '终止原因：采购计划调整，本项目终止。',
      '终止公告发布日期：2024年6月14日',
      '',
    ].join('\n');
    const files: ImportFileInput[] = [
      { fileName: 'W03-四川-跨时区-调休发布-SC2024-WZ-306.txt', text: announcement },
      { fileName: 'W08-四川-终止-SC2024-WZ-306.txt', text: termination },
    ];
    const { analysis } = await buildWindowAnalysis(files);
    const lot = lotBy(analysis, 'SC2024-WZ-306', '第一标段')!;
    expect(lot).toBeTruthy();
    // 终止公告发布日期 6/14（仅日期 → 保守边界 17:00 UTC+6 = 11:00Z）
    const cutoff = Date.UTC(2024, 5, 14, 11, 0);
    const available = lot.segments.filter((s) => s.status === 'available');
    expect(available.length).toBeGreaterThan(0);
    for (const seg of available) expect(seg.toUtc).toBeLessThanOrEqual(cutoff);
    // 终止前的可用时长仍被计入（6/11 起至 6/14 至少有若干工作小时）
    expect(lot.effectiveWorkMinutes.min).toBeGreaterThan(0);
    expect(lot.effectiveWorkMinutes.min).toBeLessThan(2010); // 小于原截止 6/19 时的完整工时
  });
});
