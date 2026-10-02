import { useState } from 'react';
import { PageSection } from '../../../components/ui';
import PayProfilePanel from './PayProfilePanel';
import PayrollRatesPanel from './PayrollRatesPanel';
import PayrollRunPanel from './PayrollRunPanel';

const SECTION_LABELS = {
  runs: '薪資結算',
  profiles: '薪資設定',
  rates: '費率設定',
} as const;
type Section = keyof typeof SECTION_LABELS;

export default function HqPayrollTab() {
  const [section, setSection] = useState<Section>('runs');

  return (
    <PageSection
      title="薪資"
      desc="依考勤、請假、加班核定與教練拆帳計算月薪資；勞健保／勞退依投保薪資與費率計算，所得稅以手動項輸入。結算後員工可於「我的出勤」查看薪資單"
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

      {section === 'runs' && <PayrollRunPanel />}
      {section === 'profiles' && <PayProfilePanel />}
      {section === 'rates' && <PayrollRatesPanel />}
    </PageSection>
  );
}
