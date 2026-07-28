import TransactionChangesPanel from '../../components/staff/TransactionChangesPanel';

/** 員工頂層「交易異動」— 僅 DUTY 以上可進入（路由守衛） */
export default function TxDashboardPage() {
  return <TransactionChangesPanel />;
}
