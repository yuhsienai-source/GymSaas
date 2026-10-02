import { useCallback, useRef, useState } from 'react';
import { fetchAllowancePrintPayload } from './api';
import type { AllowancePrintFormat } from '../components/staff/AllowancePrintView';
import type { AllowancePrintPayload } from '../types/api';

export type AllowancePrintJob = { payload: AllowancePrintPayload; format: AllowancePrintFormat };

/**
 * 折讓單列印工作：取後端 print-payload → 交給 <AllowancePrintView /> 排版列印。
 * 呼叫端渲染 `{job && <AllowancePrintView {...job} onDone={clear} />}`；錯誤由 print() 拋出供呼叫端明示。
 */
export function useAllowancePrint() {
  const [job, setJob] = useState<AllowancePrintJob | null>(null);
  const printInFlightRef = useRef(false);

  const print = useCallback(async (allowanceIdOrNo: string, format: AllowancePrintFormat = 'A4_FOUR_PART') => {
    if (printInFlightRef.current) return;
    printInFlightRef.current = true;
    try {
      const res = await fetchAllowancePrintPayload(allowanceIdOrNo, 'print');
      if (!res.data?.allowance?.allowanceNo) throw new Error(res.message || '讀取折讓單失敗');
      setJob({ payload: res.data, format });
    } finally {
      printInFlightRef.current = false;
    }
  }, []);

  const clear = useCallback(() => setJob(null), []);

  return { job, print, clear };
}
