/** 折讓單一覽匯出：只排版後端 columns／rows（CSV 由 csv.ts 處理 BOM 與防公式注入），禁止前端重算金額 */
import type { AllowanceListPayload } from '../types/api';
import { downloadCsv } from './csv';

const BRAND = 'FF083D4F';
const MONEY_FMT = '#,##0;[Red]-#,##0';

export type AllowanceExportScope = { from?: string; to?: string; branch?: string };

function baseName(scope?: AllowanceExportScope) {
  const stamp = scope?.from && scope?.to ? `${scope.from}_${scope.to}` : new Date().toISOString().slice(0, 10);
  const branch = scope?.branch ? `_${scope.branch.replace(/[\\/:*?"<>|\s]+/g, '')}` : '';
  return `折讓單一覽${branch}_${stamp}`;
}

export function downloadAllowanceCsv(data: AllowanceListPayload, scope?: AllowanceExportScope) {
  downloadCsv(`${baseName(scope)}.csv`, data.columns, data.rows);
}

/** Excel 公式注入防護：文字欄以 = + - @ 開頭者加前置單引號 */
function safeText(v: unknown) {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export async function downloadAllowanceXlsx(data: AllowanceListPayload, scope?: AllowanceExportScope) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GymSaaS';
  const sheet = wb.addWorksheet('折讓單');
  sheet.columns = data.columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: c.type === 'text' ? (/allowanceNo|refundId|subOrderId|sellerName|buyerName|reason/.test(c.key) ? 22 : 14) : 12,
  }));
  const head = sheet.getRow(1);
  head.height = 26;
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: data.columns.length } };
  for (const r of data.rows) {
    sheet.addRow(Object.fromEntries(data.columns.map((c) => [c.key, c.type === 'text' ? safeText(r[c.key]) : (r[c.key] ?? '')])));
  }
  data.columns.forEach((c, i) => {
    if (c.type === 'text') return;
    sheet.getColumn(i + 1).numFmt = c.type === 'money' ? MONEY_FMT : '#,##0';
    sheet.getColumn(i + 1).alignment = { horizontal: 'right' };
  });
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const url = URL.createObjectURL(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName(scope)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
