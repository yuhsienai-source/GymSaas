import { useRef, useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { Button, Field, Input, Modal } from '../ui';
import { useToast } from '../../contexts/ToastContext';

/** 財政部手機載具：/ + 7 碼 */
const MOBILE_CARRIER_RE = /^\/[A-Z0-9.\-+]{7}$/;
/** 自然人憑證載具：2 碼大寫英文 + 14 碼數字 */
const CITIZEN_CARRIER_RE = /^[A-Z]{2}\d{14}$/;
const LOVE_CODE_RE = /^\d{3,7}$/;

export const LOVE_CODE_PRESETS = [
  { code: '52668', label: '流浪貓絕育計劃協會' },
  { code: '921314', label: '愛貓協會' },
] as const;

export type CarrierKind = 'mobile' | 'citizen';
export type LoveDonateKind = '52668' | '921314' | 'custom';
export type InvoiceMode = 'paper' | 'ubn' | 'love' | 'carrier';

export function detectCarrierKind(raw: string): CarrierKind | 'none' {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return 'none';
  let mobile = s;
  if (!mobile.startsWith('/') && /^[A-Z0-9.\-+]{7}$/.test(mobile)) mobile = `/${mobile}`;
  if (MOBILE_CARRIER_RE.test(mobile)) return 'mobile';
  if (CITIZEN_CARRIER_RE.test(s)) return 'citizen';
  if (s.startsWith('/')) return 'mobile';
  return 'citizen';
}

export function normalizeCarrierInput(raw: string, kind: CarrierKind = 'mobile') {
  let s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  if (kind === 'mobile') {
    if (!s.startsWith('/') && /^[A-Z0-9.\-+]{7}$/.test(s)) s = `/${s}`;
  }
  return s;
}

export function isValidInvoiceCarrier(raw: string) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return true;
  let mobile = s;
  if (!mobile.startsWith('/') && /^[A-Z0-9.\-+]{7}$/.test(mobile)) mobile = `/${mobile}`;
  return MOBILE_CARRIER_RE.test(mobile) || CITIZEN_CARRIER_RE.test(s);
}

/** @deprecated 請改用 isValidInvoiceCarrier */
export function isValidMobileCarrier(raw: string) {
  return isValidInvoiceCarrier(raw);
}

/** 台灣營利事業統一編號檢查碼（財政部：權重含第 7 位×4，總和須被 5 整除） */
export function isValidTaiwanUbn(ubn: string) {
  if (!/^\d{8}$/.test(ubn)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const n = Number(ubn[i]) * weights[i];
    sum += Math.floor(n / 10) + (n % 10);
  }
  if (ubn[6] === '7') return sum % 5 === 0 || (sum + 1) % 5 === 0;
  return sum % 5 === 0;
}

/** 統編輸入正規化：全形→半形、去非數字；空字串表示清除／未填 */
export function normalizeUbnDigits(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/\D/g, '')
    .slice(0, 8);
}

/** 分店抬頭統編：空＝合法（清除）；有值須 8 碼＋檢查碼 */
export function validateOptionalSellerUbn(raw: string): string | null {
  const s = normalizeUbnDigits(raw);
  if (!s) return null;
  if (s.length !== 8) return '發票抬頭統編須為完整 8 碼，或不填以清除';
  if (!isValidTaiwanUbn(s)) {
    return '發票抬頭統編檢查碼錯誤（請填真實統編；12345678 等範例數字無效）';
  }
  return null;
}

export function isValidBuyerUbn(raw: string) {
  const s = normalizeUbnDigits(raw);
  if (!s) return true;
  return isValidTaiwanUbn(s);
}

export function isValidLoveCode(raw: string) {
  const s = String(raw || '').trim();
  if (!s) return true;
  return LOVE_CODE_RE.test(s);
}

/** 前端送出前驗證（含互斥） */
export function validateInvoiceOptions(opts: {
  carrierNum?: string;
  buyerUbn?: string;
  loveCode?: string;
}): string | null {
  const carrier = String(opts.carrierNum || '').trim();
  const ubn = String(opts.buyerUbn || '').trim();
  const love = String(opts.loveCode || '').trim();

  if (!isValidInvoiceCarrier(carrier)) {
    return '載具格式無效（手機：/＋7 碼；自然人憑證：2 英文＋14 數字）';
  }
  if (!isValidBuyerUbn(ubn)) {
    return '公司統編無效（須為 8 碼數字且通過檢查碼）';
  }
  if (!isValidLoveCode(love)) {
    return '捐贈碼無效（須為 3～7 碼純數字）';
  }
  if (love && carrier) return '發票捐贈與載具不可同時使用';
  if (ubn && love) return '公司統編發票不可同時捐贈';
  if (ubn && carrier) return '公司統編發票不可同時使用個人載具';
  return null;
}

function detectLoveKind(code: string): LoveDonateKind | 'none' {
  const s = String(code || '').trim();
  if (!s) return 'none';
  if (s === '52668') return '52668';
  if (s === '921314') return '921314';
  return 'custom';
}

function deriveMode(ubn: string, love: string, carrier: string): InvoiceMode {
  if (ubn.trim()) return 'ubn';
  if (love.trim()) return 'love';
  if (carrier.trim()) return 'carrier';
  return 'paper';
}

const MODE_OPTIONS: { id: InvoiceMode; label: string; hint: string }[] = [
  { id: 'paper', label: '紙本', hint: '不使用載具／統編／捐贈' },
  { id: 'ubn', label: '統編', hint: '公司發票 B2B' },
  { id: 'love', label: '捐贈', hint: '愛心碼捐贈' },
  { id: 'carrier', label: '載具', hint: '手機條碼或自然人憑證' },
];

interface InvoiceOptionsFieldsProps {
  carrierValue: string;
  onCarrierChange: (value: string) => void;
  buyerUbn: string;
  onBuyerUbnChange: (value: string) => void;
  loveCode: string;
  onLoveCodeChange: (value: string) => void;
}

/**
 * 電子發票選項（單選模式）：紙本｜統編｜捐贈｜載具
 */
export default function InvoiceCarrierField({
  carrierValue,
  onCarrierChange,
  buyerUbn,
  onBuyerUbnChange,
  loveCode,
  onLoveCodeChange,
}: InvoiceOptionsFieldsProps) {
  const { toast } = useToast();
  const fieldsSig = `${buyerUbn}\0${loveCode}\0${carrierValue}`;
  const derivedMode = deriveMode(buyerUbn, loveCode, carrierValue);
  const [modeOverride, setModeOverride] = useState<InvoiceMode | null>(null);
  const [prevFieldsSig, setPrevFieldsSig] = useState(fieldsSig);
  if (fieldsSig !== prevFieldsSig) {
    setPrevFieldsSig(fieldsSig);
    setModeOverride(null);
  }
  const mode = modeOverride ?? derivedMode;

  const detectedCarrier = detectCarrierKind(carrierValue);
  const [carrierKindLocal, setCarrierKindLocal] = useState<CarrierKind>('mobile');
  const carrierKind: CarrierKind =
    detectedCarrier === 'mobile' || detectedCarrier === 'citizen'
      ? detectedCarrier
      : carrierKindLocal;

  const [loveKindLocal, setLoveKindLocal] = useState<LoveDonateKind | 'none'>('none');
  const loveKind: LoveDonateKind | 'none' = loveCode.trim()
    ? detectLoveKind(loveCode)
    : loveKindLocal;

  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(true);
  const lastScanRef = useRef('');

  function switchMode(next: InvoiceMode) {
    setModeOverride(next);
    if (next !== 'ubn') onBuyerUbnChange('');
    if (next !== 'love') {
      onLoveCodeChange('');
      setLoveKindLocal('none');
    }
    if (next !== 'carrier') {
      onCarrierChange('');
      lastScanRef.current = '';
    } else if (!carrierValue) {
      setCarrierKindLocal('mobile');
    }
  }

  function changeLovePreset(next: LoveDonateKind | 'none') {
    setLoveKindLocal(next);
    if (next === 'none') {
      onLoveCodeChange('');
      return;
    }
    if (next === 'custom') {
      onLoveCodeChange('');
      return;
    }
    onLoveCodeChange(next);
  }

  function applyScanned(raw: string) {
    const normalized = normalizeCarrierInput(raw, 'mobile');
    if (!MOBILE_CARRIER_RE.test(normalized)) {
      toast('掃到的內容不是有效手機載具（需 /＋7 碼）', 'error');
      return;
    }
    if (lastScanRef.current === normalized) return;
    lastScanRef.current = normalized;
    setCarrierKindLocal('mobile');
    onCarrierChange(normalized);
    setScanOpen(false);
    setScanning(false);
    toast(`已讀取載具 ${normalized}`, 'success');
  }

  const activeHint = MODE_OPTIONS.find((m) => m.id === mode)?.hint || '';

  return (
    <div className="invoice-options">
      <div className="invoice-options__modes" role="radiogroup" aria-label="發票類型">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={mode === opt.id}
            className={`invoice-options__mode${mode === opt.id ? ' is-active' : ''}`}
            onClick={() => switchMode(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="invoice-options__hint text-muted text-sm">{activeHint}</p>

      {mode === 'ubn' && (
        <Field label="公司統編" hint="8 碼統一編號（含檢查碼）">
          <Input
            value={buyerUbn}
            onChange={(e) => onBuyerUbnChange(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="12345678"
            className="mono"
            inputMode="numeric"
            maxLength={8}
            autoComplete="off"
            autoFocus
          />
        </Field>
      )}

      {mode === 'love' && (
        <div className="form-stack" style={{ gap: '0.55rem' }}>
          <Field label="捐贈對象">
            <select
              className="input input--select"
              value={loveKind === 'none' ? '' : loveKind}
              onChange={(e) =>
                changeLovePreset((e.target.value || 'none') as LoveDonateKind | 'none')
              }
              aria-label="捐贈對象"
            >
              <option value="">請選擇…</option>
              {LOVE_CODE_PRESETS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}（{p.code}）
                </option>
              ))}
              <option value="custom">自行輸入捐贈碼</option>
            </select>
          </Field>
          {(loveKind === 'custom' || (loveKind !== 'none' && loveKind !== '52668' && loveKind !== '921314')) && (
            <Field label="捐贈碼" hint="3～7 碼純數字">
              <Input
                value={loveCode}
                onChange={(e) => onLoveCodeChange(e.target.value.replace(/\D/g, '').slice(0, 7))}
                placeholder="例如 52668"
                className="mono"
                inputMode="numeric"
                maxLength={7}
                autoComplete="off"
                autoFocus={loveKind === 'custom'}
              />
            </Field>
          )}
          {loveKind !== 'none' && loveKind !== 'custom' && (
            <p className="text-sm mono invoice-options__preview">愛心碼 {loveCode || loveKind}</p>
          )}
        </div>
      )}

      {mode === 'carrier' && (
        <div className="form-stack" style={{ gap: '0.55rem' }}>
          <div className="invoice-options__modes invoice-options__modes--sub" role="radiogroup" aria-label="載具類型">
            <button
              type="button"
              role="radio"
              aria-checked={carrierKind === 'mobile'}
              className={`invoice-options__mode${carrierKind === 'mobile' ? ' is-active' : ''}`}
              onClick={() => {
                setCarrierKindLocal('mobile');
                onCarrierChange('');
              }}
            >
              手機條碼
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={carrierKind === 'citizen'}
              className={`invoice-options__mode${carrierKind === 'citizen' ? ' is-active' : ''}`}
              onClick={() => {
                setCarrierKindLocal('citizen');
                onCarrierChange('');
              }}
            >
              自然人憑證
            </button>
          </div>
          <Field
            label={carrierKind === 'citizen' ? '憑證載具號碼' : '手機載具條碼'}
            hint={
              carrierKind === 'citizen'
                ? '2 碼大寫英文＋14 碼數字'
                : '例如 /ABC+123；可掃財政部 App'
            }
          >
            <div className="bind-row">
              <Input
                value={carrierValue}
                onChange={(e) =>
                  onCarrierChange(normalizeCarrierInput(e.target.value, carrierKind))
                }
                placeholder={carrierKind === 'citizen' ? 'AB12345678901234' : '/XXXXXXX'}
                className="mono"
                autoComplete="off"
                spellCheck={false}
                maxLength={carrierKind === 'citizen' ? 16 : 8}
                autoFocus
              />
              {carrierKind === 'mobile' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    lastScanRef.current = '';
                    setScanning(true);
                    setScanOpen(true);
                  }}
                >
                  掃碼
                </Button>
              ) : null}
              {carrierValue ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => onCarrierChange('')}>
                  清除
                </Button>
              ) : null}
            </div>
          </Field>
        </div>
      )}

      <Modal
        open={scanOpen}
        title="掃描手機載具"
        onClose={() => {
          setScanOpen(false);
          setScanning(false);
        }}
      >
        <div className="form-stack">
          <div className="scanner-wrap scanner-wrap--compact">
            {scanning && (
              <Scanner
                onScan={(detected) => {
                  const text = detected?.[0]?.rawValue;
                  if (text) applyScanned(text);
                }}
                onError={() => {
                  /* 權限拒絕等由瀏覽器提示 */
                }}
                formats={['code_39', 'code_128', 'qr_code', 'codabar']}
                constraints={{ facingMode: 'environment' }}
                styles={{ container: { width: '100%' } }}
              />
            )}
          </div>
          <p className="text-muted text-sm">
            請開啟「財政部電子發票」App → 載具條碼，對準鏡頭。
          </p>
        </div>
      </Modal>
    </div>
  );
}
