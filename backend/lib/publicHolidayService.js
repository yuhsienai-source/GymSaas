// lib/publicHolidayService.js — 國定假日曆（影響國休額度與四週排班國定假日提示）
import prisma from './prisma.js';
import { DEFAULT_PUBLIC_HOLIDAYS, dbDateKey, isDateKey, taipeiDateKey } from './laborLaw.js';

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const dateOf = (key) => new Date(`${key}T00:00:00Z`);

export function parseHolidayYear(raw) {
  if (raw === undefined || raw === null || raw === '') return Number(taipeiDateKey().slice(0, 4));
  const year = parseInt(raw, 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw httpError('年度須介於 2000–2100');
  return year;
}

function normalizeName(raw) {
  const name = String(raw ?? '').trim().slice(0, 50);
  if (!name) throw httpError('請填寫假日名稱');
  return name;
}

function defaultsFor(year) {
  return DEFAULT_PUBLIC_HOLIDAYS.filter(([date]) => date.startsWith(`${year}-`));
}

function serializeHoliday(h, todayKey) {
  const date = dbDateKey(h.date);
  return { id: h.id, date, name: h.name, weekday: dateOf(date).getUTCDay(), past: date < todayKey };
}

/** 年度假日曆；`missingDefaults`＝內建預設中該年尚未建立之筆數 */
export async function listHolidays(year) {
  const rows = await prisma.publicHoliday.findMany({
    where: { date: { gte: dateOf(`${year}-01-01`), lte: dateOf(`${year}-12-31`) } },
    orderBy: { date: 'asc' },
  });
  const todayKey = taipeiDateKey();
  const existing = new Set(rows.map((r) => dbDateKey(r.date)));
  return {
    year,
    holidays: rows.map((r) => serializeHoliday(r, todayKey)),
    missingDefaults: defaultsFor(year).filter(([date]) => !existing.has(date)).length,
    defaultYears: [...new Set(DEFAULT_PUBLIC_HOLIDAYS.map(([date]) => Number(date.slice(0, 4))))],
  };
}

export async function addHoliday({ date, name }) {
  if (!isDateKey(date)) throw httpError('日期格式須為 YYYY-MM-DD');
  try {
    const row = await prisma.publicHoliday.create({ data: { date: dateOf(date), name: normalizeName(name) } });
    return serializeHoliday(row, taipeiDateKey());
  } catch (error) {
    if (error.code === 'P2002') throw httpError('該日已設定國定假日', 409, 'HOLIDAY_EXISTS');
    throw error;
  }
}

export async function renameHoliday(id, { name }) {
  try {
    const row = await prisma.publicHoliday.update({ where: { id }, data: { name: normalizeName(name) } });
    return serializeHoliday(row, taipeiDateKey());
  } catch (error) {
    if (error.code === 'P2025') throw httpError('找不到國定假日', 404);
    throw error;
  }
}

export async function deleteHoliday(id) {
  try {
    await prisma.publicHoliday.delete({ where: { id } });
  } catch (error) {
    if (error.code === 'P2025') throw httpError('找不到國定假日', 404);
    throw error;
  }
}

/** 補入內建預設（僅指定年度；已存在日期略過） */
export async function seedDefaultHolidays(year) {
  const defaults = defaultsFor(year);
  if (!defaults.length) throw httpError(`尚無 ${year} 年內建預設，請手動建立`, 404, 'NO_DEFAULTS');
  const result = await prisma.publicHoliday.createMany({
    data: defaults.map(([date, name]) => ({ date: dateOf(date), name })),
    skipDuplicates: true,
  });
  return { count: result.count };
}
