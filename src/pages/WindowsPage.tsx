import { useMemo, useState } from 'react';
import type { WindowAnalysis, LotWindow, TimeClause } from '../core/types';
import { Badge, Drawer, Empty, KeyVal } from '../components/ui';
import type { CalendarVersionRecord } from '../core/calendar';
import { TIME_CLAUSE_KIND_LABELS } from '../core/timeClauses';
import { formatTime } from '../state/labels';
import type { WindowDiffRow } from '../core/windowPublisher';

interface WindowStrategyReport { equal: boolean; comparedAt: number; materializedAnalysisId: string; onDemandAnalysisId: string; diffs: string[] }

function hoursText(r: { min: number; max: number }): string {
  const min = (r.min / 60).toFixed(1);
  const max = (r.max / 60).toFixed(1);
  return r.min === r.max ? `${min} 小时` : `${min} – ${max} 小时`;
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function isoLocal(ms: number, offsetMinutes: number): string {
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  return shifted.toISOString().replace('T', ' ').slice(0, 16);
}

function clauseKindLabel(c: TimeClause): string {
  return TIME_CLAUSE_KIND_LABELS[c.kind];
}

export function WindowsPage(props: {
  busy: boolean;
  analyses: WindowAnalysis[];
  calendars: CalendarVersionRecord[];
  snapshots: { id: string; sources: { fileName: string }[] }[];
  onPublish: (strategy: 'materialized' | 'on_demand', calendarCutoffAt: number | null) => Promise<WindowAnalysis | undefined>;
  onCheck: () => Promise<WindowStrategyReport | undefined>;
  onDiff: (beforeVersion: number, afterVersion: number) => Promise<WindowDiffRow[] | undefined>;
}) {
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'materialized' | 'on_demand'>('on_demand');
  const [cutoff, setCutoff] = useState('');
  const [report, setReport] = useState<WindowStrategyReport | null>(null);
  const [diffBefore, setDiffBefore] = useState<number | null>(null);
  const [diffAfter, setDiffAfter] = useState<number | null>(null);
  const [diffRows, setDiffRows] = useState<WindowDiffRow[] | null>(null);

  const analysis = useMemo(() => {
    if (!props.analyses.length) return null;
    const target = selectedVersion ?? Math.max(...props.analyses.map((a) => a.version));
    return props.analyses.find((a) => a.version === target) ?? null;
  }, [props.analyses, selectedVersion]);

  const openLot: LotWindow | null = openKey
    ? analysis?.lots.find((l) => `${l.projectCode}|${l.lotCode}` === openKey) ?? null
    : null;

  const fileName = (sid: string) => props.snapshots.find((s) => s.id === sid)?.sources.map((x) => x.fileName).join(' / ') ?? sid;

  async function publish() {
    let cutoffAt: number | null = null;
    if (cutoff.trim()) {
      const parsed = Date.parse(cutoff.trim());
      if (Number.isFinite(parsed)) cutoffAt = parsed;
    }
    await props.onPublish(strategy, cutoffAt);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>标段有效投标窗口</h2>
          <div className="desc">
            量化供应商实际可获得的投标准备时间：时间条款提取器保留发布、下载、答疑、报名、递交、开标时刻与原文证据；
            窗口演算器按标段切分生效区间并扣除周末、法定假日与调休。结果仅描述可获得的准备时间，<strong>不代替法定合规裁决</strong>。
          </div>
        </div>
        {props.analyses.length > 0 && (
          <select value={analysis?.version ?? ''} onChange={(e) => setSelectedVersion(Number(e.target.value))} style={{ width: 260 }}>
            {[...props.analyses].sort((a, b) => b.version - a.version).map((a) => (
              <option key={a.id} value={a.version}>
                v{a.version} · {a.strategy === 'materialized' ? '物化区间' : '即时推演'} · {formatTime(a.computedAt)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="panel">
        <h3>① 生成窗口分析</h3>
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as 'materialized' | 'on_demand')} style={{ width: 220 }}>
            <option value="on_demand">即时推演（保留事件序列）</option>
            <option value="materialized">物化不可变区间后汇总</option>
          </select>
          <input
            placeholder="日历截止点（可选，如 2024-07-01T00:00:00Z）"
            value={cutoff}
            onChange={(e) => setCutoff(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button onClick={() => setCutoff('2024-06-15T00:00:00Z')}>用修订前日历（2024-06-15）</button>
          <button onClick={() => setCutoff('')}>用最新日历</button>
          <button className="primary" disabled={props.busy} onClick={publish}>发布窗口分析</button>
          <button disabled={props.busy} onClick={async () => setReport((await props.onCheck()) ?? null)}>双策略一致性校验</button>
        </div>
        <div className="small-text muted" style={{ marginTop: 8 }}>
          物化策略把每次更正后的时间条款固化为不可变区间，发布时汇总有效片段（更正频繁时维护与存储成本高）；
          即时策略按查询截止点结合日历推演（规则修订更灵活，但批量比较需反复计算且必须固定日历版本）。
          两种策略对同一标段必须得到相同的有效时长与逐时段证据。
          选择建议：更正频繁时优先物化（历史解释直接），分析查询量大且需要固定历法口径时优先即时推演并把日历截止点写进发布水位。
        </div>
        <div className="small-text muted" style={{ marginTop: 6 }}>
          提示：窗口分析基于“重算与发布”产生的事实；若尚未重算，请先到“计算流水线”页执行重算。日历截止点设为修订前日期（如 2024-06-15）可复现川西日历 cal-2024.1 下更长的窗口。
        </div>
        {report && (
          <div className="panel" style={{ marginTop: 12, background: report.equal ? 'var(--green-soft)' : 'var(--red-soft)', borderColor: report.equal ? '#9ed6b6' : '#f0b4ad' }}>
            <div className="flex">
              <Badge className={report.equal ? 'confirmed' : 'reject'}>{report.equal ? '两策略一致' : '两策略不一致'}</Badge>
              <span className="small-text">校验时间 {formatTime(report.comparedAt)}</span>
            </div>
            {!report.equal && <ul className="reason-list">{report.diffs.map((d, i) => <li key={i}>{d}</li>)}</ul>}
            <div className="prov">物化分析 {report.materializedAnalysisId} ／ 即时分析 {report.onDemandAnalysisId}</div>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>② 区域日历库（{props.calendars.length} 个版本，历史分析固定引用原版本）</h3>
        {props.calendars.length === 0 ? <Empty text="尚无日历版本" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>区域</th><th>版本</th><th>时区</th><th>发布时刻</th><th>修订说明</th></tr></thead>
              <tbody>
                {props.calendars.map((c) => (
                  <tr key={c.id}>
                    <td>{c.calendar.regionName}</td>
                    <td className="mono">{c.version}</td>
                    <td className="small-text">{c.calendar.timeZone}（UTC{c.calendar.offsetMinutes >= 0 ? '+' : ''}{c.calendar.offsetMinutes / 60}）</td>
                    <td className="small-text">{formatTime(c.publishedAt)}</td>
                    <td className="small-text">{c.changeNote}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!analysis ? (
        <div className="panel"><Empty text="尚无窗口分析。请先导入归档并完成重算，再点击“发布窗口分析”。" /></div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><div className="label">分析版本</div><div className="num">v{analysis.version}</div></div>
            <div className="tile"><div className="label">标段</div><div className="num">{analysis.lots.length}</div></div>
            <div className="tile"><div className="label">可判定窗口</div><div className="num">{analysis.lots.filter((l) => !l.exclusions.some((e) => e.excludesFromStats)).length}</div></div>
            <div className="tile"><div className="label">被更正缩短</div><div className="num">{analysis.lots.filter((l) => l.shortenedIntervals.length > 0).length}</div></div>
            <div className="tile"><div className="label">失效可见窗口</div><div className="num">{analysis.lots.filter((l) => l.invalidVisibleWindows.length > 0).length}</div></div>
          </div>

          <div className="panel">
            <h3>分析水位</h3>
            <div className="field-grid">
              <KeyVal k="计算策略"><Badge className="neutral">{analysis.strategy === 'materialized' ? '物化区间' : '即时推演'}</Badge></KeyVal>
              <KeyVal k="日历截止点">{formatTime(analysis.calendarCutoffAt)}</KeyVal>
              <KeyVal k="固定日历版本">
                {analysis.calendarVersions.map((c) => `${c.regionName}:${c.version}`).join('；') || '—'}
              </KeyVal>
            </div>
            <ul className="reason-list">{analysis.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>

          <div className="panel">
            <h3>③ 标段窗口（{analysis.lots.length}）</h3>
            <div className="table-wrap">
              <table>
                <thead><tr><th>项目 / 标段</th><th>地区 · 时区</th><th>采购方式 · 规模</th><th>有效工作时长</th><th>自然天数</th><th>更正 / 失效</th><th></th></tr></thead>
                <tbody>
                  {analysis.lots.map((lot) => {
                    const excluded = lot.exclusions.some((e) => e.excludesFromStats);
                    return (
                      <tr key={`${lot.projectCode}|${lot.lotCode}`}>
                        <td><div className="mono">{lot.projectCode || '（无编号）'}</div><div className="small-text">{lot.lotCode === '__ALL__' ? lot.lotName : `${lot.lotCode} · ${lot.lotName}`}</div></td>
                        <td className="small-text">{lot.regionName}<div>{lot.timeZone}</div></td>
                        <td className="small-text">{lot.procurementMethod}<div>{lot.scaleBucket}</div></td>
                        <td className="mono">{excluded ? <span className="muted">无法确定</span> : hoursText(lot.effectiveWorkMinutes)}</td>
                        <td className="mono small-text">{excluded ? '—' : `${lot.effectiveNaturalDays.min} – ${lot.effectiveNaturalDays.max} 天`}</td>
                        <td className="small-text">
                          {lot.shortenedIntervals.length > 0 && <Badge className="conflict">{lot.shortenedIntervals.length} 段被缩短</Badge>}
                          {lot.invalidVisibleWindows.length > 0 && <Badge className="pending">{lot.invalidVisibleWindows.length} 段失效</Badge>}
                          {lot.exclusions.filter((e) => e.excludesFromStats).map((e) => <Badge key={e.code} className="reject">{e.code}</Badge>)}
                        </td>
                        <td><button className="small" onClick={() => setOpenKey(`${lot.projectCode}|${lot.lotCode}`)}>逐时段证据</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {props.analyses.length > 1 && (
            <div className="panel">
              <h3>④ 版本差异（日历修订后新版另建结果）</h3>
              <div className="flex" style={{ flexWrap: 'wrap' }}>
                <select value={diffBefore ?? ''} onChange={(e) => setDiffBefore(Number(e.target.value))} style={{ width: 160 }}>
                  <option value="">对照版本…</option>
                  {[...props.analyses].sort((a, b) => a.version - b.version).map((a) => (
                    <option key={a.id} value={a.version}>v{a.version}</option>
                  ))}
                </select>
                <select value={diffAfter ?? ''} onChange={(e) => setDiffAfter(Number(e.target.value))} style={{ width: 160 }}>
                  <option value="">当前版本…</option>
                  {[...props.analyses].sort((a, b) => a.version - b.version).map((a) => (
                    <option key={a.id} value={a.version}>v{a.version}</option>
                  ))}
                </select>
                <button
                  disabled={props.busy || diffBefore === null || diffAfter === null}
                  onClick={async () => setDiffRows((await props.onDiff(diffBefore!, diffAfter!)) ?? null)}
                >
                  比较所选版本
                </button>
              </div>
              {diffRows && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table>
                    <thead><tr><th>项目 / 标段</th><th>日历版本</th><th>工时（前 → 后）</th><th>差值（中点）</th><th>状态</th></tr></thead>
                    <tbody>
                      {diffRows.map((d) => (
                        <tr key={`${d.projectCode}|${d.lotCode}`}>
                          <td><span className="mono">{d.projectCode || '（无编号）'}</span> / {d.lotCode}</td>
                          <td className="small-text">{d.calendarVersionBefore ?? '—'} → {d.calendarVersionAfter ?? '—'}</td>
                          <td className="small-text">
                            {d.workMinutesBefore ? `${(d.workMinutesBefore.min / 60).toFixed(1)}–${(d.workMinutesBefore.max / 60).toFixed(1)} h` : '—'}
                            {' → '}
                            {d.workMinutesAfter ? `${(d.workMinutesAfter.min / 60).toFixed(1)}–${(d.workMinutesAfter.max / 60).toFixed(1)} h` : '—'}
                          </td>
                          <td className="mono">{d.deltaMinutes === null ? '—' : `${(d.deltaMinutes / 60).toFixed(2)} h`}</td>
                          <td><Badge className={d.status === 'changed' ? 'pending' : d.status === 'unchanged' ? 'confirmed' : 'neutral'}>{d.status}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="panel">
            <h3>⑤ 窗口分布（地区 × 采购方式 × 标段规模）</h3>
            {analysis.distributions.length === 0 ? <Empty text="无可判定窗口" /> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>地区</th><th>采购方式</th><th>规模档</th><th>标段数</th><th>工时最小</th><th>工时中位</th><th>工时最大</th><th>排除</th></tr></thead>
                  <tbody>
                    {analysis.distributions.filter((d) => d.lotCount > 0).map((d) => (
                      <tr key={`${d.regionId}-${d.procurementMethod}-${d.scaleBucket}`}>
                        <td>{d.regionName}</td>
                        <td>{d.procurementMethod}</td>
                        <td>{d.scaleBucket}</td>
                        <td>{d.lotCount}</td>
                        <td className="mono">{d.hoursMin.toFixed(1)} h</td>
                        <td className="mono">{d.hoursMedian.toFixed(1)} h</td>
                        <td className="mono">{d.hoursMax.toFixed(1)} h</td>
                        <td>{d.excludedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h3>⑥ 排除原因汇总</h3>
            {analysis.exclusions.length === 0 ? <Empty text="无排除项" /> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>排除码</th><th>标段数</th><th>标段</th></tr></thead>
                  <tbody>
                    {analysis.exclusions.map((e) => (
                      <tr key={e.code}>
                        <td className="mono">{e.code}</td>
                        <td>{e.lotCount}</td>
                        <td className="small-text">{e.lots.join('、')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {openLot && analysis && (
        <Drawer title={`逐时段证据 · ${openLot.projectCode || '（无编号）'} / ${openLot.lotCode}`} onClose={() => setOpenKey(null)}>
          <div className="field-grid">
            <KeyVal k="区域 / 时区">{openLot.regionName} · {openLot.timeZone}（UTC{openLot.offsetMinutes >= 0 ? '+' : ''}{openLot.offsetMinutes / 60}）</KeyVal>
            <KeyVal k="采购方式 / 规模">{openLot.procurementMethod} · {openLot.scaleBucket}<div className="prov">{openLot.scaleBasis}</div></KeyVal>
            <KeyVal k="固定日历版本">{openLot.calendarVersion ?? '无常可用日历'}</KeyVal>
            <KeyVal k="有效工作时长">{hoursText(openLot.effectiveWorkMinutes)}</KeyVal>
            <KeyVal k="自然时长">{openLot.effectiveNaturalDays.min} – {openLot.effectiveNaturalDays.max} 天</KeyVal>
          </div>

          <hr className="sep" />
          <h3>时间条款与原文证据（{openLot.clauses.length}）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>类别</th><th>角色</th><th>日期 / 时刻</th><th>精度</th><th>标段</th><th>来源 · 原文</th></tr></thead>
              <tbody>
                {[...openLot.clauses].sort((a, b) => a.date.localeCompare(b.date)).map((c) => (
                  <tr key={c.id}>
                    <td>{clauseKindLabel(c)}</td>
                    <td>{c.role === 'current' ? <Badge className="confirmed">现行</Badge> : <Badge className="rejected">被替换</Badge>}</td>
                    <td className="mono">{c.date}{c.time ? ` ${c.time}` : ''}</td>
                    <td className="small-text">{c.precision === 'date' ? '仅日期（保守范围）' : '精确到分'}</td>
                    <td className="small-text">{c.lotCode ?? '全项目'}</td>
                    <td className="small-text">{fileName(c.snapshotId)}<div className="prov">「{c.evidence.text}」 · {c.ruleId}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <hr className="sep" />
          <h3>生效区间（逐时段）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>状态</th><th>UTC 区间</th><th>本地区间</th><th>工作时长</th><th>自然天</th><th>依据</th></tr></thead>
              <tbody>
                {openLot.segments.map((s, i) => (
                  <tr key={i}>
                    <td><Badge className={s.status === 'available' ? 'confirmed' : s.status === 'gap' ? 'pending' : 'neutral'}>{s.status === 'available' ? '可用' : s.status === 'gap' ? '失效空档' : s.status}</Badge></td>
                    <td className="mono small-text">{isoUtc(s.fromUtc)}<br />→ {isoUtc(s.toUtc)}</td>
                    <td className="mono small-text">{isoLocal(s.fromUtc, openLot.offsetMinutes)}<br />→ {isoLocal(s.toUtc, openLot.offsetMinutes)}</td>
                    <td className="mono small-text">{(s.workMinutes.min / 60).toFixed(1)} – {(s.workMinutes.max / 60).toFixed(1)} h</td>
                    <td className="small-text">{s.naturalDays.min} – {s.naturalDays.max}</td>
                    <td className="small-text">{s.reasons.map((r, j) => <div key={j}>{r}</div>)}<div className="prov">条款 {s.evidenceClauseIds.join('、')}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {openLot.shortenedIntervals.length > 0 && (
            <>
              <hr className="sep" />
              <h3>被更正缩短的区间</h3>
              {openLot.shortenedIntervals.map((s, i) => (
                <div key={i} className="panel" style={{ marginBottom: 8 }}>
                  <div className="flex"><Badge className="conflict">{s.kind === 'submission' ? '递交截止' : '报名截止'}</Badge><span className="small-text">{isoUtc(s.fromUtc)} → {isoUtc(s.toUtc)}</span></div>
                  <div className="small-text">被缩短工时 {hoursText(s.workMinutes)}；自然天 {s.naturalDays.min} – {s.naturalDays.max}</div>
                  {s.reasons.map((r, j) => <div key={j} className="prov">{r}</div>)}
                </div>
              ))}
            </>
          )}

          {openLot.invalidVisibleWindows.length > 0 && (
            <>
              <hr className="sep" />
              <h3>实际可见的失效窗口（不倒填新截止）</h3>
              {openLot.invalidVisibleWindows.map((s, i) => (
                <div key={i} className="panel" style={{ marginBottom: 8 }}>
                  <div className="flex"><Badge className="pending">{s.kind === 'submission' ? '递交' : '报名'}</Badge><span className="small-text">{isoUtc(s.fromUtc)} → {isoUtc(s.toUtc)}（{s.naturalDays} 天）</span></div>
                  <div className="prov">{s.reason}</div>
                </div>
              ))}
            </>
          )}

          {openLot.exclusions.length > 0 && (
            <>
              <hr className="sep" />
              <h3>排除与不确定范围</h3>
              {openLot.exclusions.map((e) => (
                <div key={e.code} className="prov">
                  <Badge className={e.excludesFromStats ? 'reject' : 'neutral'}>{e.code}</Badge> {e.message}
                </div>
              ))}
              {openLot.timeZoneUncertainty?.undetermined && (
                <div className="prov">
                  时区不确定：可能偏移 {openLot.timeZoneUncertainty.offsetRangeMinutes?.[0]} ～ {openLot.timeZoneUncertainty.offsetRangeMinutes?.[1]} 分钟，
                  UTC 范围为跨全球时区跨度，不计入统计。
                </div>
              )}
            </>
          )}
        </Drawer>
      )}
    </div>
  );
}
