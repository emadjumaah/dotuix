import type { Staff } from '../types';
import { initials } from '../utils';

interface Props {
  staff: Staff[];
  onSignOut: () => void;
}

export function SettingsScreen({ staff, onSignOut }: Props) {
  async function doExport() {
    if (typeof uix !== 'undefined' && uix?.state?.exportBundle) {
      try {
        await uix.state.exportBundle();
      } catch (e) {
        console.error('Export failed', e);
      }
    } else {
      alert('uix.state.exportBundle() is not available in this environment.');
    }
  }

  async function doImport() {
    if (typeof uix !== 'undefined' && uix?.state?.importBundle) {
      try {
        await uix.state.importBundle();
        window.location.reload();
      } catch (e) {
        const err = e as Error;
        if (err?.message !== 'cancelled') console.error('Import failed', e);
      }
    } else {
      alert('uix.state.importBundle() is not available in this environment.');
    }
  }

  return (
    <div className="settings-screen">
      <div className="orders-header">
        <h2 className="screen-title">Settings</h2>
      </div>
      <div className="settings-content">
        {/* ── Data Transfer ────────────────────────────── */}
        <div className="settings-section">
          <div className="settings-section-title">Data Transfer</div>
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-info-title">Export Data</div>
              <div className="settings-info-sub">
                Save all orders and settings as a <code>.uixdata</code> bundle via{' '}
                <code>uix.state.exportBundle()</code>
              </div>
            </div>
            <button className="settings-btn" onClick={doExport}>
              Export
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-info-title">Import Data</div>
              <div className="settings-info-sub">
                Restore from a <code>.uixdata</code> bundle via{' '}
                <code>uix.state.importBundle()</code>
              </div>
            </div>
            <button className="settings-btn" onClick={doImport}>
              Import
            </button>
          </div>
        </div>

        {/* ── Staff ────────────────────────────────────── */}
        <div className="settings-section">
          <div className="settings-section-title">Staff</div>
          <div className="staff-table">
            {staff.map((s) => (
              <div key={s.id} className="staff-row">
                <div className="staff-row-avatar" style={{ background: s.color }}>
                  {initials(s.name)}
                </div>
                <span className="staff-row-name">{s.name}</span>
                <span className="staff-row-role">{s.role}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── System Info ──────────────────────────────── */}
        <div className="settings-section">
          <div className="settings-section-title">System</div>
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-info-title">App Version</div>
              <div className="settings-info-sub">Nexus POS 2.0.0</div>
            </div>
            <span className="tag tag-gold">v2.0.0</span>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-info-title">Schema Version</div>
              <div className="settings-info-sub">
                Current data model — migration from v1 supported
              </div>
            </div>
            <span className="tag tag-info">v2</span>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-info-title">State Mode</div>
              <div className="settings-info-sub">All data stays on this device</div>
            </div>
            <span className="tag tag-success">device</span>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-info-title">Network</div>
              <div className="settings-info-sub">No external connections permitted</div>
            </div>
            <span className="tag tag-danger">blocked</span>
          </div>
          <div className="settings-row">
            <div className="settings-info">
              <div className="settings-info-title">Sign Out</div>
              <div className="settings-info-sub">Return to staff selection screen</div>
            </div>
            <button className="settings-btn danger" onClick={onSignOut}>
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
