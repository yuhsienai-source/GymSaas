/** 前端 CSV 組檔（資料由後端計算）：UTF-8 BOM 供 Excel 正確顯示中文、CRLF 換行 */

export type CsvColumn = { key: string; label: string };
export type CsvCell = string | number | boolean | null | undefined;

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  // 防 CSV 公式注入（Excel 會執行 = + - @ 開頭之儲存格）
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: CsvColumn[], rows: Record<string, CsvCell>[]): string {
  const lines = [columns.map((c) => escapeCell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c.key])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function downloadCsv(filename: string, columns: CsvColumn[], rows: Record<string, CsvCell>[]) {
  const blob = new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
