/**
 * 区域日历库：保存区域时区、工作日、法定假日与临时调休日，
 * 并支持日历版本冻结 —— 历史日期后的日历修订不回溯改变已发布分析。
 *
 * 纯数据 + 纯函数，无 DOM/网络依赖，可在 Worker 与 Node 测试中复用。
 * 所有时刻均以 UTC 毫秒存储；区域本地时间通过固定偏移换算（中国区域无夏令时，
 * 但模型保留 offsetMinutes 字段以便扩展）。
 */

export interface HolidayDay {
  /** YYYY-MM-DD（区域本地日期） */
  date: string;
  name: string;
}

export interface MakeupWorkday {
  /** YYYY-MM-DD，原本是周末但临时上班 */
  date: string;
  reason: string;
}

export interface RegionCalendar {
  regionId: string;
  regionName: string;
  /** IANA 风格标识，如 Asia/Shanghai */
  timeZone: string;
  /** 相对 UTC 的固定偏移分钟数（如 +480） */
  offsetMinutes: number;
  /** 工作日（1=周一 … 7=周日） */
  workdays: number[];
  holidays: HolidayDay[];
  makeupWorkdays: MakeupWorkday[];
  /** 日历版本，修订时递增；发布分析引用具体版本 */
  version: string;
  /** 每日工作时段（区域本地时间），用于可用工作时长演算 */
  dailyWorkHours: {
    start: string;
    end: string;
    /** 午休（可为空） */
    breakStart: string | null;
    breakEnd: string | null;
  };
  /** 生效说明（何时发布、适用范围） */
  note: string;
}

export interface CalendarEvent {
  date: string;
  type: 'holiday' | 'makeup';
  name: string;
}

// ---------- 日历版本化存储 ----------

/** 区域日历版本：版本号 + 发布时刻 + 不可变数据快照 */
export interface CalendarVersionRecord {
  /** `${regionId}@${version}`，仓储主键 */
  id: string;
  regionId: string;
  version: string;
  publishedAt: number;
  calendar: RegionCalendar;
  /** 修订说明（为何新增该版本） */
  changeNote: string;
}

export interface CalendarChange {
  regionId: string;
  version: string;
  at: number;
  changeNote: string;
}

export class CalendarRegistry {
  /** regionId -> 按 publishedAt 升序排列的版本 */
  private versions = new Map<string, CalendarVersionRecord[]>();
  private auditLog: CalendarChange[] = [];

  /** 注册/追加一个日历版本（同一 (regionId, version) 幂等） */
  addVersion(record: CalendarVersionRecord): void {
    if (!record.id) record.id = `${record.regionId}@${record.version}`;
    const list = this.versions.get(record.regionId) ?? [];
    if (list.some((r) => r.version === record.version)) return;
    list.push(record);
    list.sort((a, b) => a.publishedAt - b.publishedAt);
    this.versions.set(record.regionId, list);
    this.auditLog.push({
      regionId: record.regionId,
      version: record.version,
      at: record.publishedAt,
      changeNote: record.changeNote,
    });
  }

  /** 取某区域的最新版本 */
  latest(regionId: string): RegionCalendar | null {
    const list = this.versions.get(regionId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1].calendar;
  }

  getVersion(regionId: string, version: string): RegionCalendar | null {
    const list = this.versions.get(regionId) ?? [];
    return list.find((r) => r.version === version)?.calendar ?? null;
  }

  /** 取某发布时刻当时有效的日历版本（历史分析复算使用） */
  asOf(regionId: string, at: number): RegionCalendar | null {
    const list = this.versions.get(regionId) ?? [];
    const eligible = list.filter((r) => r.publishedAt <= at);
    return eligible.length ? eligible[eligible.length - 1].calendar : null;
  }

  allLatest(): RegionCalendar[] {
    return [...this.versions.keys()].sort().map((id) => this.latest(id)!).filter(Boolean);
  }

  allVersions(): CalendarVersionRecord[] {
    return [...[...this.versions.values()].flat()].sort(
      (a, b) => a.regionId.localeCompare(b.regionId) || a.publishedAt - b.publishedAt,
    );
  }

  changes(): CalendarChange[] {
    return [...this.auditLog].sort((a, b) => a.regionId.localeCompare(b.regionId) || a.at - b.at);
  }

  has(regionId: string): boolean {
    return this.versions.has(regionId);
  }
}

// ---------- 日期计算工具（纯 UTC 运算，避免宿主时区干扰） ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD → 当日 00:00 的 UTC 纪元天数 */
export function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 纪元天数 → YYYY-MM-DD */
export function dayToIso(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** ISO 星期：1=周一 … 7=周日 */
export function isoWeekday(isoDate: string): number {
  const dow = new Date(dayNumber(isoDate) * DAY_MS).getUTCDay(); // 0=周日
  return dow === 0 ? 7 : dow;
}

/** 区域本地日期/时刻 → UTC 毫秒 */
export function localToUtc(
  date: string,
  time: string | null,
  offsetMinutes: number,
): { from: number; to: number; wholeDay: boolean } {
  const [y, m, d] = date.split('-').map(Number);
  const hasTime = !!time && /^\d{2}:\d{2}$/.test(time);
  const [hh, mm] = hasTime ? time!.split(':').map(Number) : [0, 0];
  const fromLocal = Date.UTC(y, m - 1, d, hh, mm) - offsetMinutes * 60 * 1000;
  if (hasTime) return { from: fromLocal, to: fromLocal, wholeDay: false };
  // 只见日期无时刻：保守边界为当天 00:00 → 次日 00:00（不得假定全天可用）
  return { from: fromLocal, to: fromLocal + DAY_MS, wholeDay: true };
}

/** UTC 毫秒 → 区域本地日期与时刻 */
export function utcToLocal(ms: number, offsetMinutes: number): { date: string; time: string } {
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16),
  };
}

/** 某区域本地日期是否为工作日（含临时调休与法定假日覆盖） */
export function isWorkday(calendar: RegionCalendar, isoDate: string): boolean {
  const makeup = calendar.makeupWorkdays.some((m) => m.date === isoDate);
  if (makeup) return true;
  const holiday = calendar.holidays.some((h) => h.date === isoDate);
  if (holiday) return false;
  return calendar.workdays.includes(isoWeekday(isoDate));
}

export function calendarEvent(calendar: RegionCalendar, isoDate: string): CalendarEvent | null {
  const h = calendar.holidays.find((x) => x.date === isoDate);
  if (h) return { date: isoDate, type: 'holiday', name: h.name };
  const m = calendar.makeupWorkdays.find((x) => x.date === isoDate);
  if (m) return { date: isoDate, type: 'makeup', name: m.reason };
  return null;
}

/**
 * 统计 [from, to) 区间内（UTC 毫秒）区域本地的工作日天数。
 * wholeDayFrom/To 表示端点仅精确到日期：保守做法是整日计入或排除，
 * 由调用方通过 halfOpen 控制；此处按本地日期整天计数。
 */
export interface WorkdayBreakdown {
  workdays: number;
  weekendDays: number;
  holidayDays: number;
  makeupDays: number;
  /** 逐日明细（本地日期 + 是否计为工作日 + 事件） */
  days: { date: string; workday: boolean; event: CalendarEvent | null }[];
}

export function countWorkdays(
  calendar: RegionCalendar,
  fromMs: number,
  toMs: number,
): WorkdayBreakdown {
  const out: WorkdayBreakdown = {
    workdays: 0,
    weekendDays: 0,
    holidayDays: 0,
    makeupDays: 0,
    days: [],
  };
  if (!(toMs > fromMs)) return out;
  const startDate = utcToLocal(fromMs, calendar.offsetMinutes).date;
  // 末日的边界：若 to 恰为本地 00:00，则该日不计入
  const endLocal = utcToLocal(toMs, calendar.offsetMinutes);
  const endDate = endLocal.time === '00:00' ? dayToIso(dayNumber(endLocal.date) - 1) : endLocal.date;
  const lastDay = dayNumber(endDate);
  for (let day = dayNumber(startDate); day <= lastDay; day++) {
    const date = dayToIso(day);
    const ev = calendarEvent(calendar, date);
    const workday = isWorkday(calendar, date);
    out.days.push({ date, workday, event: ev });
    if (workday) {
      out.workdays += 1;
      if (ev?.type === 'makeup') out.makeupDays += 1;
    } else if (ev?.type === 'holiday') {
      out.holidayDays += 1;
    } else {
      out.weekendDays += 1;
    }
  }
  return out;
}

/** 当前日历年 ISO 周数与工作日计数辅助（用于分析分桶：窗口自然时长档） */
export function naturalDays(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / DAY_MS);
}

// ---------- 可用工作时长演算 ----------

function localWallMs(ms: number, offsetMinutes: number): number {
  return ms + offsetMinutes * 60 * 1000;
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return (h * 60 + m) * 60 * 1000;
}

/**
 * 统计 [fromMs, toMs) 与区域工作时段（含午休扣除）重合的分钟数。
 * 全部按区域本地墙钟计算后折回 UTC，因此不受宿主时区影响。
 */
export function workMinutesBetween(calendar: RegionCalendar, fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  const offset = calendar.offsetMinutes;
  const fromWall = localWallMs(fromMs, offset);
  const toWall = localWallMs(toMs, offset);
  const startDate = new Date(fromWall).toISOString().slice(0, 10);
  const endWallProbe = new Date(toWall - 1).toISOString().slice(0, 10);
  const firstDay = dayNumber(startDate);
  const lastDay = dayNumber(endWallProbe);
  const { start, end, breakStart, breakEnd } = calendar.dailyWorkHours;
  let minutes = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const date = dayToIso(day);
    if (!isWorkday(calendar, date)) continue;
    const [y, m, d] = date.split('-').map(Number);
    const dayBase = Date.UTC(y, m - 1, d);
    const periods: [number, number][] = [];
    if (breakStart && breakEnd) {
      periods.push([dayBase + parseHm(start), dayBase + parseHm(breakStart)]);
      periods.push([dayBase + parseHm(breakEnd), dayBase + parseHm(end)]);
    } else {
      periods.push([dayBase + parseHm(start), dayBase + parseHm(end)]);
    }
    for (const [ps, pe] of periods) {
      const lo = Math.max(ps, fromWall);
      const hi = Math.min(pe, toWall);
      if (hi > lo) minutes += (hi - lo) / 60000;
    }
  }
  return Math.round(minutes * 1000) / 1000;
}

/** 完整工作日可提供的分钟数 */
export function minutesPerWorkday(calendar: RegionCalendar): number {
  const { start, end, breakStart, breakEnd } = calendar.dailyWorkHours;
  const full = parseHm(end) - parseHm(start);
  const lunch = breakStart && breakEnd ? parseHm(breakEnd) - parseHm(breakStart) : 0;
  return (full - lunch) / 60000;
}

/** 依据发布时刻对全部区域取当时有效的日历版本快照 */
export function calendarsAsOf(registry: CalendarRegistry, at: number): RegionCalendar[] {
  return registry
    .allVersions()
    .filter((r) => r.publishedAt <= at)
    .reduce<RegionCalendar[]>((acc, r) => {
      const idx = acc.findIndex((c) => c.regionId === r.regionId);
      if (idx >= 0) acc[idx] = r.calendar;
      else acc.push(r.calendar);
      return acc;
    }, [])
    .sort((a, b) => a.regionId.localeCompare(b.regionId));
}

// ---------- 内置中国区域日历（虚构演示数据） ----------

function cnRegion(
  regionId: string,
  regionName: string,
  timeZone: string,
  holidays: [string, string][],
  makeup: [string, string][],
  note: string,
  version = 'cal-2024.1',
): RegionCalendar {
  const offsetOf: Record<string, number> = {
    'Asia/Shanghai': 480,
    'Asia/Urumqi': 360,
    'Asia/Hong_Kong': 480,
  };
  return {
    regionId,
    regionName,
    timeZone,
    offsetMinutes: offsetOf[timeZone] ?? 480,
    workdays: [1, 2, 3, 4, 5],
    dailyWorkHours: { start: '09:00', end: '17:00', breakStart: '12:00', breakEnd: '13:30' },
    holidays: holidays.map(([date, name]) => ({ date, name })),
    makeupWorkdays: makeup.map(([date, reason]) => ({ date, reason })),
    version,
    note,
  };
}

const NATIONAL_2024_HOLIDAYS: [string, string][] = [
  ['2024-01-01', '元旦'],
  ['2024-02-10', '春节'], ['2024-02-11', '春节'], ['2024-02-12', '春节'],
  ['2024-02-13', '春节'], ['2024-02-14', '春节'], ['2024-02-15', '春节'],
  ['2024-02-16', '春节'], ['2024-02-17', '春节'],
  ['2024-04-04', '清明节'], ['2024-04-05', '清明节'], ['2024-04-06', '清明节'],
  ['2024-05-01', '劳动节'], ['2024-05-02', '劳动节'], ['2024-05-03', '劳动节'],
  ['2024-05-04', '劳动节'], ['2024-05-05', '劳动节'],
  ['2024-06-10', '端午节'],
  ['2024-09-15', '中秋节'], ['2024-09-16', '中秋节'], ['2024-09-17', '中秋节'],
  ['2024-10-01', '国庆节'], ['2024-10-02', '国庆节'], ['2024-10-03', '国庆节'],
  ['2024-10-04', '国庆节'], ['2024-10-05', '国庆节'], ['2024-10-06', '国庆节'],
  ['2024-10-07', '国庆节'],
];

const NATIONAL_2024_MAKEUP: [string, string][] = [
  ['2024-02-04', '春节调休上班'],
  ['2024-02-18', '春节调休上班'],
  ['2024-04-07', '清明调休上班'],
  ['2024-04-28', '劳动节调休上班'],
  ['2024-05-11', '劳动节调休上班'],
  ['2024-09-14', '中秋调休上班'],
  ['2024-09-29', '国庆调休上班'],
  ['2024-10-12', '国庆调休上班'],
];

// 四川甘孜/凉山等地存在民族自治州额外假日（虚构示例：川西州庆）
const SICHUAN_EXTRA_HOLIDAYS: [string, string][] = [
  ['2024-06-06', '川西州庆'],
  ['2024-06-07', '川西州庆'],
];
const SICHUAN_EXTRA_MAKEUP: [string, string][] = [
  ['2024-06-08', '川西州庆调休上班'],
];

export function defaultCalendarRegistry(): CalendarRegistry {
  const reg = new CalendarRegistry();
  const seed: [RegionCalendar, number, string][] = [
    [
      cnRegion('ZJ', '浙江', 'Asia/Shanghai', NATIONAL_2024_HOLIDAYS, NATIONAL_2024_MAKEUP,
        '2024 年全国节假日安排；浙江省按北京时间工作日（周一至周五）'),
      1_700_000_000_000,
      '初始版本：2024 年全国法定假日与调休',
    ],
    [
      cnRegion('AH', '安徽', 'Asia/Shanghai', NATIONAL_2024_HOLIDAYS, NATIONAL_2024_MAKEUP,
        '2024 年全国节假日安排；安徽省按北京时间工作日（周一至周五）'),
      1_700_000_000_000,
      '初始版本：2024 年全国法定假日与调休',
    ],
    [
      // 四川示例区域使用乌鲁木齐偏移以演示跨时区（西部门户按 6 小时偏移结算）
      cnRegion('SC', '四川（川西）', 'Asia/Urumqi', [...NATIONAL_2024_HOLIDAYS, ...SICHUAN_EXTRA_HOLIDAYS], [...NATIONAL_2024_MAKEUP, ...SICHUAN_EXTRA_MAKEUP],
        '川西民族自治州适用额外州庆假日；公告按区域门户设定 UTC+6 截止时区'),
      1_700_000_000_000,
      '初始版本：全国假日 + 川西州庆调休',
    ],
    [
      cnRegion('GD', '广东', 'Asia/Shanghai', NATIONAL_2024_HOLIDAYS, NATIONAL_2024_MAKEUP,
        '2024 年全国节假日安排；广东省按北京时间工作日'),
      1_700_000_000_000,
      '初始版本：2024 年全国法定假日与调休',
    ],
  ];
  for (const [calendar, publishedAt, changeNote] of seed) {
    reg.addVersion({
      id: `${calendar.regionId}@${calendar.version}`,
      regionId: calendar.regionId,
      version: calendar.version,
      publishedAt,
      calendar,
      changeNote,
    });
  }
  // 演示“历史日期后更正日历”：四川新增一个追溯性州庆假日，形成新版本
  const sc = reg.latest('SC')!;
  const revised: RegionCalendar = {
    ...sc,
    version: 'cal-2024.2',
    holidays: [...sc.holidays, { date: '2024-06-17', name: '川西州庆（补充公告）' }],
    note: sc.note + '；cal-2024.2 补充 6 月 17 日州庆（发布晚于该日期）',
  };
  reg.addVersion({
    id: `SC@${revised.version}`,
    regionId: 'SC',
    version: revised.version,
    // 发布于 2024-07-01：晚于 6 月的历史日期，用于验证“历史分析继续引用原日历版本”
    publishedAt: Date.UTC(2024, 6, 1),
    calendar: revised,
    changeNote: '补充 2024-06-17 川西州庆假日；历史分析若引用 cal-2024.1 应保持不变',
  });
  return reg;
}
