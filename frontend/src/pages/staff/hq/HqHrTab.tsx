import { useState } from 'react';
import { PageSection } from '../../../components/ui';
import HqAttendancePanel from './HqAttendancePanel';
import HqHolidayPanel from './HqHolidayPanel';
import HqLeavePanel from './HqLeavePanel';
import HqPayrollPanel from './HqPayrollPanel';
import HqSchedulePanel from './HqSchedulePanel';
import type { HqDataProps } from './types';

const SECTION_LABELS = {
  attendance: '考勤',
  leaves: '請假',
  schedules: '排班',
  holidays: '國定假日',
  payroll: '工資匯出',
} as const;
type Section = keyof typeof SECTION_LABELS;

type Props = Pick<HqDataProps, 'staffList' | 'branches' | 'onReload'>;

export default function HqHrTab({ staffList, branches, onReload }: Props) {
  const [section, setSection] = useState<Section>('attendance');

  return (
    <PageSection
      title="員工 HR"
      desc="考勤比對班表、請假審核、排班（四週排班＋週班表審核＋跨店班表總覽）、國定假日曆、工資核算匯出；員工打卡、請假申請與 LINE 通知綁定請至側欄「我的出勤」"
    >
      <nav className="hq-tabs" role="tablist">
        {(Object.keys(SECTION_LABELS) as Section[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            className={`hq-tabs__btn ${section === key ? 'is-active' : ''}`}
            onClick={() => setSection(key)}
          >
            {SECTION_LABELS[key]}
          </button>
        ))}
      </nav>

      {section === 'attendance' && <HqAttendancePanel staffList={staffList} branches={branches} />}
      {section === 'leaves' && <HqLeavePanel staffList={staffList} branches={branches} onReload={onReload} />}
      {section === 'schedules' && <HqSchedulePanel staffList={staffList} branches={branches} />}
      {section === 'holidays' && <HqHolidayPanel onReload={onReload} />}
      {section === 'payroll' && <HqPayrollPanel branches={branches} />}
    </PageSection>
  );
}
