import { useEffect, useRef, useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { Alert, Button, Field, Input, Modal, Select } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import InvoiceCarrierField from './InvoiceCarrierField';

export type PayMethodCode = 'CASH' | 'CARD' | 'YIPAY' | 'LINEPAY' | 'WALLET_CASH' | 'VOUCHER';

export type CardPayMode = 'LUMP' | 'INSTALLMENT' | 'RECURRING';

export type PaymentLine = {
  method: PayMethodCode;
  amount: number;
  voucherCode?: string;
};

export const CARD_INSTALLMENT_OPTIONS = [3, 6, 9, 12, 18, 24, 30] as const;

export type CardPayOptions = {
  cardMode: CardPayMode;
  cardInst: number | null;
  periodType: 'W' | 'M' | 'Y' | null;
  periodTimes: number | null;
  /** 定期定額續扣基準金額（首期應付仍為 totalAmount） */
  recurringAmount: number | null;
};

export const DEFAULT_CARD_PAY_OPTIONS: CardPayOptions = {
  cardMode: 'LUMP',
  cardInst: null,
  periodType: null,
  periodTimes: null,
  recurringAmount: null,
};

const METHOD_LABELS: Record<PayMethodCode, string> = {
  CASH: '現金',
  YIPAY: '現場刷卡',
  CARD: 'PayUNi',
  LINEPAY: 'LinePay',
  WALLET_CASH: '零錢包',
  VOUCHER: '抵用券',
};

const METHOD_HINTS: Partial<Record<PayMethodCode, string>> = {
  YIPAY: '乙禾／凱基',
  CARD: '定期定額',
  LINEPAY: 'POS 掃碼',
  WALLET_CASH: '僅本金',
  VOUCHER: '掃碼',
};

const CARD_MODE_LABELS: Record<CardPayMode, string> = {
  LUMP: '一次付清',
  INSTALLMENT: '分期繳納',
  RECURRING: '定期定額',
};

function roundMoney(n: number) {
  return Math.round(n * 100) / 100;
}

interface CompositePayFieldsProps {
  totalAmount: number;
  allowedMethods: PayMethodCode[];
  selected: PayMethodCode[];
  onSelectedChange: (methods: PayMethodCode[]) => void;
  amounts: Partial<Record<PayMethodCode, number>>;
  onAmountsChange: (amounts: Partial<Record<PayMethodCode, number>>) => void;
  voucherCode: string;
  onVoucherCodeChange: (code: string) => void;
  carrierValue: string;
  onCarrierChange: (v: string) => void;
  buyerUbn: string;
  onBuyerUbnChange: (v: string) => void;
  loveCode: string;
  onLoveCodeChange: (v: string) => void;
  hint?: string;
  /** 刷卡子選項；未選 CARD 時可忽略 */
  cardOptions?: CardPayOptions;
  onCardOptionsChange?: (opts: CardPayOptions) => void;
  /** 是否允許定期定額（通常依方案 enableCardRecurring） */
  allowCardRecurring?: boolean;
  /** 限制 PayUNi 可選模式（臨櫃預設僅 RECURRING；線上可 LUMP／INSTALLMENT／RECURRING） */
  payuniCardModes?: CardPayMode[];
  /** 定期定額可選總期數（例如課程方案 bitmask 解出的 [2]／[4]／[2,4]） */
  allowedPeriodTimes?: number[];
  /** 定期定額預設總期數（例如方案 periodCount） */
  defaultPeriodTimes?: number;
  /** 定期定額預設期付金額（通常＝方案價或課程續期金額） */
  defaultRecurringAmount?: number;
  /** 鎖定期付金額（方案表定，禁止臨櫃改） */
  lockRecurringAmount?: boolean;
  /**
   * 月卡／課程定期定額臨櫃：允許「乙禾首期」＋「PayUNi 約定」同選；
   * CARD 金額須為 0（僅標記），首期金額全放 YIPAY
   */
  allowYipayPayuniRecurring?: boolean;
  /** 臨櫃 LinePay POS：會員付款碼（My Code／oneTimeKey） */
  linePayOneTimeKey?: string;
  onLinePayOneTimeKeyChange?: (key: string) => void;
}

/**
 * 複合付款：多選方式、分攤金額（合計須＝應付）、刷卡分期／定期定額、抵用券掃碼、電子發票選項
 */
export default function CompositePayFields({
  totalAmount,
  allowedMethods,
  selected,
  onSelectedChange,
  amounts,
  onAmountsChange,
  voucherCode,
  onVoucherCodeChange,
  carrierValue,
  onCarrierChange,
  buyerUbn,
  onBuyerUbnChange,
  loveCode,
  onLoveCodeChange,
  hint,
  cardOptions = DEFAULT_CARD_PAY_OPTIONS,
  onCardOptionsChange,
  allowCardRecurring = false,
  payuniCardModes,
  allowedPeriodTimes,
  defaultPeriodTimes,
  defaultRecurringAmount,
  lockRecurringAmount = false,
  allowYipayPayuniRecurring = false,
  linePayOneTimeKey = '',
  onLinePayOneTimeKeyChange,
}: CompositePayFieldsProps) {
  const { toast } = useToast();
  const [voucherScanOpen, setVoucherScanOpen] = useState(false);
  const [linePayScanOpen, setLinePayScanOpen] = useState(false);
  const lastVoucherScan = useRef('');
  const lastLinePayScan = useRef('');
  const showLinePayKey = selected.includes('LINEPAY') && Boolean(onLinePayOneTimeKeyChange);

  const sum = roundMoney(
    selected
      .filter((m) => !(allowYipayPayuniRecurring && m === 'CARD'))
      .reduce((s, m) => s + (Number(amounts[m]) || 0), 0),
  );
  const remaining = roundMoney(totalAmount - sum);
  const balanced = Math.abs(remaining) < 0.009 && selected.length > 0;
  const showCardOpts =
    (selected.includes('CARD') ||
      (allowYipayPayuniRecurring && selected.includes('YIPAY'))) &&
    Boolean(onCardOptionsChange);

  useEffect(() => {
    if (selected.length === 1) {
      const only = selected[0];
      if (roundMoney(amounts[only] || 0) !== roundMoney(totalAmount)) {
        onAmountsChange({ ...amounts, [only]: roundMoney(totalAmount) });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join(','), totalAmount]);

  // 月卡定期定額：CARD 僅約定標記，金額固定 0；首期全放乙禾
  useEffect(() => {
    if (!allowYipayPayuniRecurring) return;
    if (!selected.includes('CARD') && !selected.includes('YIPAY')) return;
    const next = { ...amounts };
    let changed = false;
    if (selected.includes('CARD') && roundMoney(next.CARD || 0) !== 0) {
      next.CARD = 0;
      changed = true;
    }
    if (
      selected.includes('YIPAY') &&
      selected.includes('CARD') &&
      selected.filter((m) => m !== 'CARD').length === 1
    ) {
      if (roundMoney(next.YIPAY || 0) !== roundMoney(totalAmount)) {
        next.YIPAY = roundMoney(totalAmount);
        changed = true;
      }
    }
    if (changed) onAmountsChange(next);
    if (cardOptions.cardMode !== 'RECURRING' && allowCardRecurring) {
      onCardOptionsChange?.({
        ...DEFAULT_CARD_PAY_OPTIONS,
        cardMode: 'RECURRING',
        periodType: 'M',
        periodTimes: defaultPeriodTimes ?? 12,
        recurringAmount: defaultRecurringAmount ?? null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allowYipayPayuniRecurring,
    selected.join(','),
    totalAmount,
    allowCardRecurring,
  ]);

  useEffect(() => {
    if (!showCardOpts) return;
    if (cardOptions.cardMode === 'RECURRING' && !allowCardRecurring) {
      onCardOptionsChange?.({
        ...DEFAULT_CARD_PAY_OPTIONS,
        cardMode: 'LUMP',
      });
    }
  }, [allowCardRecurring, cardOptions.cardMode, onCardOptionsChange, showCardOpts]);

  function toggleMethod(method: PayMethodCode) {
    if (selected.includes(method)) {
      const next = selected.filter((m) => m !== method);
      const nextAmounts = { ...amounts };
      delete nextAmounts[method];
      onSelectedChange(next);
      onAmountsChange(nextAmounts);
      if (method === 'VOUCHER') onVoucherCodeChange('');
      if (method === 'CARD') onCardOptionsChange?.(DEFAULT_CARD_PAY_OPTIONS);
      if (method === 'LINEPAY') onLinePayOneTimeKeyChange?.('');
    } else {
      let next = [...selected, method];
      const nextAmounts = { ...amounts };
      // PayUNi／乙禾／LinePay 互斥（月卡定期定額除外：允許 YIPAY＋CARD 約定）
      const drop = (m: PayMethodCode) => {
        next = next.filter((x) => x !== m);
        delete nextAmounts[m];
      };
      if (method === 'LINEPAY') {
        if (next.includes('CARD')) {
          drop('CARD');
          onCardOptionsChange?.(DEFAULT_CARD_PAY_OPTIONS);
        }
        if (next.includes('YIPAY')) drop('YIPAY');
      }
      if (method === 'CARD') {
        if (next.includes('LINEPAY')) {
          drop('LINEPAY');
          onLinePayOneTimeKeyChange?.('');
        }
        if (next.includes('YIPAY') && !allowYipayPayuniRecurring) drop('YIPAY');
        if (allowYipayPayuniRecurring) {
          nextAmounts.CARD = 0;
          if (!next.includes('YIPAY')) {
            next.push('YIPAY');
            nextAmounts.YIPAY = roundMoney(totalAmount);
          }
        }
        // 臨櫃 PayUNi 僅定期定額時自動帶入
        if (payuniCardModes?.length === 1 && payuniCardModes[0] === 'RECURRING') {
          onCardOptionsChange?.({
            ...DEFAULT_CARD_PAY_OPTIONS,
            cardMode: 'RECURRING',
            periodType: 'M',
            periodTimes: defaultPeriodTimes ?? 12,
            recurringAmount: defaultRecurringAmount ?? null,
          });
        }
      }
      if (method === 'YIPAY') {
        if (next.includes('CARD') && !allowYipayPayuniRecurring) {
          drop('CARD');
          onCardOptionsChange?.(DEFAULT_CARD_PAY_OPTIONS);
        }
        if (next.includes('LINEPAY')) {
          drop('LINEPAY');
          onLinePayOneTimeKeyChange?.('');
        }
        if (allowYipayPayuniRecurring && allowCardRecurring) {
          if (!next.includes('CARD')) next.push('CARD');
          nextAmounts.CARD = 0;
          onCardOptionsChange?.({
            ...DEFAULT_CARD_PAY_OPTIONS,
            cardMode: 'RECURRING',
            periodType: 'M',
            periodTimes: defaultPeriodTimes ?? 12,
            recurringAmount: defaultRecurringAmount ?? null,
          });
        }
      }
      onSelectedChange(next);
      onAmountsChange(nextAmounts);
    }
  }

  function setAmount(method: PayMethodCode, raw: string) {
    if (allowYipayPayuniRecurring && method === 'CARD') return;
    const n = parseFloat(raw);
    onAmountsChange({
      ...amounts,
      [method]: Number.isFinite(n) && n >= 0 ? n : 0,
    });
  }

  function fillRemaining(method: PayMethodCode) {
    if (allowYipayPayuniRecurring && method === 'CARD') return;
    const others = roundMoney(
      selected
        .filter((m) => m !== method && !(allowYipayPayuniRecurring && m === 'CARD'))
        .reduce((s, m) => s + (Number(amounts[m]) || 0), 0),
    );
    onAmountsChange({ ...amounts, [method]: roundMoney(Math.max(0, totalAmount - others)) });
  }

  function applyVoucherScan(raw: string) {
    const code = raw.trim().toUpperCase();
    if (!code) return;
    if (lastVoucherScan.current === code) return;
    lastVoucherScan.current = code;
    onVoucherCodeChange(code);
    setVoucherScanOpen(false);
    toast(`已讀取抵用券 ${code}`, 'success');
  }

  function applyLinePayScan(raw: string) {
    const key = raw.trim();
    if (!key || key.length < 8) return;
    if (lastLinePayScan.current === key) return;
    lastLinePayScan.current = key;
    onLinePayOneTimeKeyChange?.(key);
    setLinePayScanOpen(false);
    toast('已讀取 LinePay 付款碼', 'success');
  }

  function setCardMode(mode: CardPayMode) {
    if (mode === 'RECURRING' && !allowCardRecurring) return;
    if (mode === 'INSTALLMENT') {
      const prevInst = cardOptions.cardInst;
      const validInst =
        prevInst != null &&
        (CARD_INSTALLMENT_OPTIONS as readonly number[]).includes(prevInst)
          ? prevInst
          : 3;
      onCardOptionsChange?.({
        cardMode: 'INSTALLMENT',
        cardInst: validInst,
        periodType: null,
        periodTimes: null,
        recurringAmount: null,
      });
      return;
    }
    if (mode === 'RECURRING') {
      const allowed =
        allowedPeriodTimes && allowedPeriodTimes.length > 0
          ? allowedPeriodTimes.filter((n) => Number.isInteger(n) && n > 0)
          : null;
      const times =
        allowed && allowed.length === 1
          ? allowed[0]
          : defaultPeriodTimes != null &&
              defaultPeriodTimes > 0 &&
              (!allowed || allowed.includes(defaultPeriodTimes))
            ? defaultPeriodTimes
            : allowed && allowed.length > 0
              ? allowed[0]
              : cardOptions.periodTimes ?? 12;
      const defaultAmt =
        defaultRecurringAmount != null && defaultRecurringAmount > 0
          ? roundMoney(defaultRecurringAmount)
          : cardOptions.recurringAmount ?? roundMoney(totalAmount);
      onCardOptionsChange?.({
        cardMode: 'RECURRING',
        cardInst: null,
        periodType: 'M',
        periodTimes: times,
        recurringAmount: defaultAmt,
      });
      return;
    }
    onCardOptionsChange?.(DEFAULT_CARD_PAY_OPTIONS);
  }

  const cardModeChoices: CardPayMode[] = payuniCardModes?.length
    ? payuniCardModes
    : allowCardRecurring
      ? (['LUMP', 'INSTALLMENT', 'RECURRING'] as CardPayMode[])
      : (['LUMP', 'INSTALLMENT'] as CardPayMode[]);

  return (
    <div className="checkout-flow">
      <section className="checkout-flow__block">
        <header className="checkout-flow__head">
          <h3>付款</h3>
          <p>{hint || '可複選；分攤合計須等於應付金額'}</p>
        </header>

        <div className="pay-method-grid" role="group" aria-label="付款方式">
          {allowedMethods.map((m) => {
            const on = selected.includes(m);
            return (
              <button
                key={m}
                type="button"
                className={`pay-method-chip${on ? ' is-active' : ''}`}
                aria-pressed={on}
                onClick={() => toggleMethod(m)}
              >
                <span className="pay-method-chip__label">{METHOD_LABELS[m]}</span>
                {METHOD_HINTS[m] ? (
                  <span className="pay-method-chip__hint">{METHOD_HINTS[m]}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {selected.length === 0 && <Alert tone="warning">請至少選擇一種付款方式</Alert>}

        {allowYipayPayuniRecurring && (
          <Alert tone="info">
            月卡／課程定期定額：首期以「現場刷卡（乙禾）」收款；確認後開 PayUNi
            續期頁（$1 驗證授權後取消、不請款；第 2 期起原價）。
          </Alert>
        )}

        {selected.length > 1 && (
          <div className="pay-split-list">
            {selected.map((m) => {
              const bindOnly = allowYipayPayuniRecurring && m === 'CARD';
              return (
                <div key={m} className="pay-split-row">
                  <span className="pay-split-row__label">
                    {METHOD_LABELS[m]}
                    {bindOnly ? '（續期約定）' : ''}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    value={bindOnly ? 0 : (amounts[m] ?? '')}
                    onChange={(e) => setAmount(m, e.target.value)}
                    aria-label={`${METHOD_LABELS[m]}金額`}
                    disabled={bindOnly}
                  />
                  {!bindOnly && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => fillRemaining(m)}>
                      補足
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showCardOpts && (
          <div className="card-pay-opts">
            <header className="checkout-flow__head">
              <h3>PayUNi 定期定額</h3>
              <p>
                {allowYipayPayuniRecurring
                  ? '乙禾收首期後，另開 PayUNi 續期頁（FAmt＝$1 驗證授權→取消；PeriodAmt 自第 2 期）'
                  : cardModeChoices.length === 1 && cardModeChoices[0] === 'RECURRING'
                    ? '臨櫃定期定額走統一金流續期收款；一次現場刷卡請改選「現場刷卡（乙禾）」'
                    : '一次付清、銀行分期，或方案允許時的定期定額'}
              </p>
            </header>
            <div className="pay-method-grid pay-method-grid--card" role="group" aria-label="PayUNi 刷卡方式">
              {cardModeChoices.map((mode) => {
                const on = cardOptions.cardMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`pay-method-chip${on ? ' is-active' : ''}`}
                    aria-pressed={on}
                    onClick={() => setCardMode(mode)}
                  >
                    <span className="pay-method-chip__label">{CARD_MODE_LABELS[mode]}</span>
                  </button>
                );
              })}
            </div>

            {cardOptions.cardMode === 'INSTALLMENT' && (
              <Field label="分期期數" hint="須於 PayUNi 商店後台開通對應期數">
                <Select
                  value={String(cardOptions.cardInst || 3)}
                  onChange={(e) =>
                    onCardOptionsChange?.({
                      cardMode: 'INSTALLMENT',
                      cardInst: parseInt(e.target.value, 10),
                      periodType: null,
                      periodTimes: null,
                      recurringAmount: null,
                    })
                  }
                >
                  {CARD_INSTALLMENT_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n} 期
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {cardOptions.cardMode === 'RECURRING' && (
              <div className="form-stack">
                <Field
                  label="期付金額"
                  hint={
                    lockRecurringAmount
                      ? '依方案表定；本次首期應付見上方購物車合計'
                      : '續期幕後扣款以此為準；本次首期應付仍為上方購物車合計'
                  }
                >
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    readOnly={lockRecurringAmount}
                    value={cardOptions.recurringAmount ?? defaultRecurringAmount ?? ''}
                    onChange={(e) => {
                      if (lockRecurringAmount) return;
                      const n = parseFloat(e.target.value);
                      onCardOptionsChange?.({
                        ...cardOptions,
                        cardMode: 'RECURRING',
                        recurringAmount: Number.isFinite(n) && n > 0 ? roundMoney(n) : null,
                      });
                    }}
                  />
                </Field>
                <Field label="扣款週期">
                  <Select
                    value={cardOptions.periodType || 'M'}
                    onChange={(e) =>
                      onCardOptionsChange?.({
                        ...cardOptions,
                        cardMode: 'RECURRING',
                        periodType: e.target.value as 'W' | 'M' | 'Y',
                      })
                    }
                  >
                    <option value="W">每週</option>
                    <option value="M">每月</option>
                    <option value="Y">每年</option>
                  </Select>
                </Field>
                <Field
                  label="總期數"
                  hint={
                    allowedPeriodTimes && allowedPeriodTimes.length > 0
                      ? `此方案可選：${allowedPeriodTimes.join('／')} 期；首期於本次刷卡完成`
                      : '0＝不限期數（依約定持續扣款）；首期於本次刷卡完成'
                  }
                >
                  {allowedPeriodTimes && allowedPeriodTimes.length > 0 ? (
                    <Select
                      value={String(
                        cardOptions.periodTimes != null &&
                          allowedPeriodTimes.includes(cardOptions.periodTimes)
                          ? cardOptions.periodTimes
                          : allowedPeriodTimes[0],
                      )}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        onCardOptionsChange?.({
                          ...cardOptions,
                          cardMode: 'RECURRING',
                          periodTimes: Number.isInteger(n) && n > 0 ? n : allowedPeriodTimes[0],
                        });
                      }}
                    >
                      {allowedPeriodTimes.map((n) => (
                        <option key={n} value={n}>
                          {n} 期
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      type="number"
                      min={0}
                      max={99}
                      value={cardOptions.periodTimes ?? 12}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        onCardOptionsChange?.({
                          ...cardOptions,
                          cardMode: 'RECURRING',
                          periodTimes: Number.isInteger(n) && n >= 0 ? n : 0,
                        });
                      }}
                    />
                  )}
                </Field>
                <Alert tone="info">
                  定期定額走 PayUNi「續期收款」支付頁綁卡並約定後續扣款。
                </Alert>
              </div>
            )}
          </div>
        )}

        {selected.includes('VOUCHER') && (
          <Field label="抵用券條碼">
            <div className="bind-row">
              <Input
                value={voucherCode}
                onChange={(e) => onVoucherCodeChange(e.target.value.toUpperCase())}
                placeholder="掃描或輸入條碼"
                className="mono"
                autoComplete="off"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  lastVoucherScan.current = '';
                  setVoucherScanOpen(true);
                }}
              >
                掃碼
              </Button>
            </div>
          </Field>
        )}

        {showLinePayKey && (
          <Field
            label="LinePay 付款碼（My Code）"
            hint="請會員開啟 LINE Pay「付款碼」，以掃碼槍或鏡頭掃入；沙盒請用官方測試頁產生碼"
          >
            <div className="bind-row">
              <Input
                value={linePayOneTimeKey}
                onChange={(e) => onLinePayOneTimeKeyChange?.(e.target.value.trim())}
                placeholder="掃描或輸入付款碼"
                className="mono"
                autoComplete="off"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  lastLinePayScan.current = '';
                  setLinePayScanOpen(true);
                }}
              >
                掃碼
              </Button>
            </div>
          </Field>
        )}

        {selected.length > 0 && (
          <div className={`pay-balance${balanced ? ' is-ok' : ' is-warn'}`}>
            <span>應付 ${roundMoney(totalAmount)}</span>
            <span>已分攤 ${sum}</span>
            <span>{balanced ? '金額相符' : `尚差 $${remaining}`}</span>
          </div>
        )}
      </section>

      <section className="checkout-flow__block">
        <header className="checkout-flow__head">
          <h3>電子發票</h3>
          <p>選擇一種開立方式；預設紙本</p>
        </header>
        <InvoiceCarrierField
          carrierValue={carrierValue}
          onCarrierChange={onCarrierChange}
          buyerUbn={buyerUbn}
          onBuyerUbnChange={onBuyerUbnChange}
          loveCode={loveCode}
          onLoveCodeChange={onLoveCodeChange}
        />
      </section>

      <Modal
        open={voucherScanOpen}
        title="掃描抵用券條碼"
        onClose={() => setVoucherScanOpen(false)}
      >
        <div className="form-stack">
          <div className="scanner-wrap scanner-wrap--compact">
            <Scanner
              onScan={(detected) => {
                const text = detected?.[0]?.rawValue;
                if (text) applyVoucherScan(text);
              }}
              formats={['code_39', 'code_128', 'qr_code', 'codabar', 'ean_13']}
              constraints={{ facingMode: 'environment' }}
              styles={{ container: { width: '100%' } }}
            />
          </div>
          <p className="text-muted text-sm">將抵用券條碼對準鏡頭，或使用掃碼槍掃入上方輸入框。</p>
        </div>
      </Modal>

      <Modal
        open={linePayScanOpen}
        title="掃描 LinePay 付款碼"
        onClose={() => setLinePayScanOpen(false)}
      >
        <div className="form-stack">
          <div className="scanner-wrap scanner-wrap--compact">
            <Scanner
              onScan={(detected) => {
                const text = detected?.[0]?.rawValue;
                if (text) applyLinePayScan(text);
              }}
              formats={['code_39', 'code_128', 'qr_code', 'codabar', 'ean_13']}
              constraints={{ facingMode: 'environment' }}
              styles={{ container: { width: '100%' } }}
            />
          </div>
          <p className="text-muted text-sm">
            請掃會員 LINE Pay「付款碼／My Code」（非會員身分 QR）。
          </p>
        </div>
      </Modal>
    </div>
  );
}

export function buildPaymentsPayload(
  selected: PayMethodCode[],
  amounts: Partial<Record<PayMethodCode, number>>,
  voucherCode: string,
  opts?: { omitZeroCard?: boolean },
): PaymentLine[] {
  return selected
    .filter((method) => !(opts?.omitZeroCard && method === 'CARD' && !(Number(amounts.CARD) > 0)))
    .map((method) => ({
      method,
      amount: roundMoney(amounts[method] || 0),
      ...(method === 'VOUCHER' ? { voucherCode: voucherCode.trim() } : {}),
    }));
}

/** hasCard：選了 CARD，或乙禾＋定期定額（僅送 cardMode，首期走 YIPAY） */
export function buildCardPayPayload(
  opts: CardPayOptions,
  hasCard: boolean,
  forceRecurring?: boolean,
) {
  if (!hasCard && !forceRecurring) return {};
  if (opts.cardMode === 'INSTALLMENT' && !forceRecurring) {
    return {
      cardMode: 'INSTALLMENT' as const,
      cardInst: opts.cardInst || 3,
    };
  }
  if (opts.cardMode === 'RECURRING' || forceRecurring) {
    return {
      cardMode: 'RECURRING' as const,
      periodType: opts.periodType || 'M',
      periodTimes: opts.periodTimes ?? 12,
      ...(opts.recurringAmount != null && opts.recurringAmount > 0
        ? { recurringAmount: opts.recurringAmount }
        : {}),
    };
  }
  return { cardMode: 'LUMP' as const };
}

export function isPaymentsBalanced(
  selected: PayMethodCode[],
  amounts: Partial<Record<PayMethodCode, number>>,
  totalAmount: number,
  opts?: { ignoreCardAmount?: boolean },
) {
  if (selected.length === 0) return false;
  const sum = roundMoney(
    selected
      .filter((m) => !(opts?.ignoreCardAmount && m === 'CARD'))
      .reduce((s, m) => s + (Number(amounts[m]) || 0), 0),
  );
  return Math.abs(sum - roundMoney(totalAmount)) < 0.009;
}

export { METHOD_LABELS, CARD_MODE_LABELS };
