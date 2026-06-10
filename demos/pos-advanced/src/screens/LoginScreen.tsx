import { useState } from 'react';
import type { Staff } from '../types';
import { initials } from '../utils';

interface Props {
  staff: Staff[];
  onLogin: (staff: Staff) => void;
}

export function LoginScreen({ staff, onLogin }: Props) {
  const [selected, setSelected] = useState<Staff | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  function selectStaff(s: Staff) {
    setSelected(s);
    setPin('');
    setError('');
  }

  function pressKey(k: string) {
    if (k === 'clear') {
      setPin('');
      setError('');
      return;
    }
    if (k === 'del') {
      setPin((p) => p.slice(0, -1));
      setError('');
      return;
    }
    if (pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    if (next.length === 4) {
      setTimeout(() => checkPin(next), 120);
    }
  }

  function checkPin(entered: string) {
    if (!selected) return;
    if (entered === selected.pin) {
      onLogin(selected);
    } else {
      setPin('');
      setError('Incorrect PIN — try again');
    }
  }

  return (
    <div className="login-screen">
      <div className="login-logo">
        <div className="login-dot" />
        <div>
          <span className="login-title">Nexus POS</span>
          <p className="login-sub">Select your profile to continue</p>
        </div>
      </div>

      <div className="staff-grid">
        {staff.map((s) => (
          <button
            key={s.id}
            className={`staff-card${selected?.id === s.id ? ' active' : ''}`}
            onClick={() => selectStaff(s)}
          >
            <div className="staff-avatar" style={{ background: s.color }}>
              {initials(s.name)}
            </div>
            <span className="staff-name">{s.name}</span>
            <span className="staff-role">{s.role}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="pin-card">
          <div className="pin-title">{selected.name} — Enter PIN</div>

          <div className="pin-dots">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`pin-dot${i < pin.length ? ' filled' : ''}`} />
            ))}
          </div>

          <div className="pin-grid">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'].map((k) => (
              <button
                key={k}
                className={`pin-key${k === 'del' ? ' del' : ''}`}
                onClick={() => pressKey(k)}
              >
                {k === 'del' ? '⌫' : k === 'clear' ? 'C' : k}
              </button>
            ))}
          </div>

          {error && <p className="pin-error">{error}</p>}

          <button className="pin-cancel" onClick={() => setSelected(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
