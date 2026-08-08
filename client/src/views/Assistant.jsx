import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const SUGGESTIONS = [
  'Which machines will run out of stock first?',
  'What is currently wrong with the fleet?',
  'Which machines are offline right now?',
  'What are our best selling products this week?',
  'Tell me about VM-1005',
];

export default function Assistant() {
  const [log, setLog] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState(null);
  const endRef = useRef(null);

  useEffect(() => { api.aiProvider().then(setProvider).catch(() => {}); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);

  async function ask(text) {
    const q = (text ?? question).trim();
    if (!q || busy) return;
    setQuestion('');
    setLog((l) => [...l, { role: 'q', text: q }]);
    setBusy(true);
    try {
      const res = await api.ask(q);
      setLog((l) => [...l, { role: 'a', ...res }]);
    } catch (e) {
      setLog((l) => [...l, { role: 'a', answer: e.message, error: true, trace: [] }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Ops assistant</h2>
        {provider && (
          <span className="faint" style={{ fontSize: 12 }}>
            {provider.provider === 'claude'
              ? `Claude - ${provider.model}`
              : 'Offline analyzer - set ANTHROPIC_API_KEY for Claude'}
          </span>
        )}
      </div>

      <div className="panel-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Answers come from live queries against the fleet database, not from the model's memory.
          Every response shows the tools it called so you can check the numbers yourself.
        </p>

        <div className="assistant-log">
          {log.length === 0 && (
            <div className="empty">Ask a question about the fleet.</div>
          )}

          {log.map((entry, i) =>
            entry.role === 'q' ? (
              <div className="bubble q" key={i}>{entry.text}</div>
            ) : (
              <div className="bubble a" key={i}>
                <div style={{ color: entry.error ? 'var(--crit)' : undefined }}>{entry.answer}</div>
                {entry.trace?.length > 0 && (
                  <details className="trace">
                    <summary>
                      {entry.trace.length} tool call{entry.trace.length > 1 ? 's' : ''}:{' '}
                      {entry.trace.map((t) => t.tool).join(', ')}
                    </summary>
                    <pre>{JSON.stringify(entry.trace, null, 2)}</pre>
                  </details>
                )}
              </div>
            ),
          )}

          {busy && <div className="bubble a faint">Querying the fleet...</div>}
          <div ref={endRef} />
        </div>

        <div className="ask-row">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            placeholder="Ask about machines, stock, alerts, or sales..."
            disabled={busy}
          />
          <button className="primary" onClick={() => ask()} disabled={busy || !question.trim()}>
            Ask
          </button>
        </div>

        <div className="chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => ask(s)} disabled={busy}>{s}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
