import { IcoCycle } from '../components/Icons';
import { readStoredTeamKey } from '../board/utils';

export function CyclesPage() {
  const teamKey = readStoredTeamKey();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoCycle /></span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Cycles</span>
        {teamKey && (
          <>
            <span style={{ color: 'var(--fg-faint)', fontSize: 12 }}>·</span>
            <span className="mono" style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 3,
              background: 'var(--bg-hover)', border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
            }}>
              {teamKey}
            </span>
          </>
        )}
        <div style={{ flex: 1 }} />
      </div>

      <div className="page-content">
        <div className="empty-state">
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            border: '1px solid var(--border)',
            background: 'var(--bg-raised)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 16,
          }}>
            <IcoCycle size={22} style={{ color: 'var(--fg-faint)' }} />
          </div>
          <h3>No cycles configured</h3>
          <p>
            Cycles functionality is coming soon. Manage your sprint cycles in Linear and they will sync here.
          </p>
        </div>
      </div>
    </div>
  );
}
