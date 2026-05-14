import { IcoPlus, IcoProject } from '../components/Icons';
import { Btn } from '../components/Primitives';

export function ProjectsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <div className="page-header">
        <span style={{ color: 'var(--fg-dim)', display: 'inline-flex' }}><IcoProject /></span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Projects</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>0</span>
        <div style={{ flex: 1 }} />
        <Btn variant="subtle" icon={<IcoPlus size={12} />} size="sm">New project</Btn>
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
            <IcoProject size={22} style={{ color: 'var(--fg-faint)' }} />
          </div>
          <h3>No projects yet</h3>
          <p>
            Projects functionality is coming soon. Configure projects in your Linear workspace and they will sync here.
          </p>
        </div>
      </div>
    </div>
  );
}
