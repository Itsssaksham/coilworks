import { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Login({ onAuthed }) {
  const [email, setEmail] = useState('viewer@coilworks.io');
  const [password, setPassword] = useState('coilworks');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, operator } = await api.login(email, password);
      setToken(token);
      onAuthed(operator);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login panel" onSubmit={submit}>
        <div className="panel-body">
          <div className="brand">
            <span className="brand-mark" />
            Coilworks
          </div>

          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>

          <button className="primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in...' : 'Sign in'}
          </button>

          {error && <div className="error">{error}</div>}

          <div className="hint">
            <strong>Demo login</strong> — read-only.
            <br />
            <span className="num">viewer@coilworks.io</span> / <span className="num">coilworks</span>
            <br />
            <span className="faint">
              Explore the whole fleet. Changing state (resolving alerts, restocking,
              planning runs) needs a dispatcher account.
            </span>
          </div>
        </div>
      </form>
    </div>
  );
}
