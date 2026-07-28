import { useEffect, useRef, useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import { Alert, Button, Field, Input, Modal, Select } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import InvoiceCarrierField from './InvoiceCarrierField';

export type PayMethodCode = 'CASH' | 'CARD' | 'WALLET_CASH' | 'VOUCHER';

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
  CARD: '刷卡',
  WALLET_CASH: '零錢包',
  VOUCHER: '抵用券',
};

const METHOD_HINTS: Partial<Record<PayMethodCode, string>> = {
  CARD: 'PayUNi',
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
  /** 定期定額預設總期數（例如方案 periodCount） */
  defaultPeriodTimes?: number;
  /** 定期定額預設期付金額（通常＝方案價） */
  defaultRecurringAmount?: number;
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
  defaultPeriodTimes,
  defaultRecurringAmount,
}: CompositePayFieldsProps) {
  const { toast } = useToast();
  const [voucherScanOpen, setVoucherScanOpen] = useState(false);
  const lastVoucherScan = useRef('');

  const sum = roundMoney(selected.reduce((s, m) => s + (Number(amounts[m]) || 0), 0));
  const remaining = roundMoney(totalAmount - sum);
  const balanced = Math.abs(remaining) < 0.009 && selected.length > 0;
  const showCardOpts = selected.includes('CARD') && Boolean(onCardOptionsChange);

  useEffect(() => {
    if (selected.length === 1) {
      const only = selected[0];
      if (roundMoney(amounts[only] || 0) !== roundMoney(totalAmount)) {
        onAmountsChange({ ...amounts, [only]: roundMoney(totalAmount) });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join(','), totalAmount]);

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
    } else {
      onSelectedChange([...selected, method]);
    }
  }

  function setAmount(method: PayMethodCode, raw: string) {
    const n = parseFloat(raw);
    onAmountsChange({
      ...amounts,
      [method]: Number.isFinite(n) && n >= 0 ? n : 0,
    });
  }

  function fillRemaining(method: PayMethodCode) {
    const others = roundMoney(
      selected.filter((m) => m !== method).reduce((s, m) => s + (Number(amounts[m]) || 0), 0),
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
      const times =
        defaultPeriodTimes != null && defaultPeriodTimes > 0
          ? defaultPeriodTimes
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

  const cardModes: CardPayMode[] = allowCardRecurring
    ? ['LUMP', 'INSTALLMENT', 'RECURRING']
    : ['LUMP', 'INSTALLMENT'];

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

        {selected.length > 1 && (
          <div className="pay-split-list">
            {selected.map((m) => (
              <div key={m} className="pay-split-row">
                <span className="pay-split-row__label">{METHOD_LABELS[m]}</span>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  value={amounts[m] ?? ''}
                  onChange={(e) => setAmount(m, e.target.value)}
                  aria-label={`${METHOD_LABELS[m]}金額`}
                />
                <Button type="button" size="sm" variant="ghost" onClick={() => fillRemaining(m)}>
                  補足
                </Button>
              </div>
            ))}
          </div>
        )}

        {showCardOpts && (
          <div className="card-pay-opts">
            <header className="checkout-flow__head">
              <h3>刷卡方式</h3>
              <p>一次付清、銀行分期，或方案允許時的定期定額</p>
            </header>
            <div className="pay-method-grid pay-method-grid--card" role="group" aria-label="刷卡方式">
              {cardModes.map((mode) => {
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
                  hint="續期幕後扣款以此為準；本次首期應付仍為上方購物車合計"
                >
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={cardOptions.recurringAmount ?? defaultRecurringAmount ?? ''}
                    onChange={(e) => {
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
                  hint="0＝不限期數（依約定持續扣款）；首期於本次刷卡完成"
                >
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
                </Field>
                <Alert tone="info">
                  定期定額會於 PayUNi 約定信用卡 Token（CreditHash），供後續續期扣款。
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
    </div>
  );
}

export function buildPaymentsPayload(
  selected: PayMethodCode[],
  amounts: Partial<Record<PayMethodCode, number>>,
  voucherCode: string,
): PaymentLine[] {
  return selected.map((method) => ({
    method,
    amount: roundMoney(amounts[method] || 0),
    ...(method === 'VOUCHER' ? { voucherCode: voucherCode.trim() } : {}),
  }));
}

export function buildCardPayPayload(opts: CardPayOptions, hasCard: boolean) {
  if (!hasCard) return {};
  if (opts.cardMode === 'INSTALLMENT') {
    return {
      cardMode: 'INSTALLMENT' as const,
      cardInst: opts.cardInst || 3,
    };
  }
  if (opts.cardMode === 'RECURRING') {
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
) {
  if (selected.length === 0) return false;
  const sum = roundMoney(selected.reduce((s, m) => s + (Number(amounts[m]) || 0), 0));
  return Math.abs(sum - roundMoney(totalAmount)) < 0.009;
}

export { METHOD_LABELS, CARD_MODE_LABELS };
