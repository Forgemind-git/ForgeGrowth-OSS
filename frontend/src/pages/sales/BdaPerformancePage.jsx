import { useState, useEffect, useCallback } from 'react';
import { Trophy } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { showError } from '../../lib/feedback.js';
import { PageShell, Table, Td, Segmented, EmptyState } from '../academy/shared.jsx';
import { Shimmer } from '../../components/charts.jsx';

const PERIODS = [{ value: 'week', label: 'This Week' }, { value: 'month', label: 'This Month' }, { value: 'all', label: 'All Time' }];
const RANK_COLORS = ['#E8A317', '#9AA4AF', '#B87333'];

export default function BdaPerformancePage({ user }) {
  const [period, setPeriod] = useState('month');
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await api.bda.performance(period); setBoard(d.leaderboard); }
    catch (e) { showError(e.message); }
    finally { setLoading(false); }
  }, [period]);
  useEffect(() => { load(); }, [load]);

  function fmtResp(sec) {
    if (sec == null) return '—';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${(sec / 3600).toFixed(1)}h`;
  }

  return (
    <PageShell
      title="BDA Performance"
      subtitle="Conversion leaderboard aggregated from the activity log and lead outcomes."
      actions={<Segmented options={PERIODS} value={period} onChange={setPeriod} />}
    >
      {loading ? <Shimmer height={320} radius={12} /> : (
        <Table
          columns={[{ label: '#' }, { label: 'BDA' }, { label: 'First Response' }, { label: 'Messages', align: 'right' },
            { label: 'Triggers', align: 'right' }, { label: 'Leads Handled', align: 'right' }, { label: 'Converted', align: 'right' }, { label: 'Conversion', align: 'right' }]}
          rows={board} keyOf={r => r.bda}
          empty={<EmptyState Icon={Trophy} title="No activity yet" hint="Add team members and start logging activity." />}
          renderRow={(r, i) => (
            <>
              <Td>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 99, fontFamily: MONO, fontSize: 11, fontWeight: 700,
                  background: i < 3 ? RANK_COLORS[i] : C.hover, color: i < 3 ? '#fff' : C.textSecondary }}>{i + 1}</span>
              </Td>
              <Td bold>{r.name}</Td>
              <Td mono color={C.textSecondary}>{fmtResp(r.firstResponseTime)}</Td>
              <Td align="right" mono>{r.messagesSent}</Td>
              <Td align="right" mono>{r.triggersFired}</Td>
              <Td align="right" mono>{r.leadsHandled}</Td>
              <Td align="right" mono bold color={C.green}>{r.converted}</Td>
              <Td align="right">
                <span style={{ fontFamily: MONO, fontWeight: 700, color: r.conversionPct >= 15 ? C.green : r.conversionPct > 0 ? C.amber : C.textMuted }}>{r.conversionPct}%</span>
              </Td>
            </>
          )}
        />
      )}
    </PageShell>
  );
}
