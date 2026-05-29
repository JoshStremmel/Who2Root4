/* Game detail overlay — full reasoning + impact meter + tiebreaker context. */

const { useEffect: useDetailEffect } = React;

function GameDetail({ rec, fav, onClose }) {
  useDetailEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!rec) return null;

  const root = window.TEAMS[rec.rootFor];
  const against = window.TEAMS[rec.against];
  const reasons = (rec.reasonsAll && rec.reasonsAll.length) ? rec.reasonsAll : [rec.reasoning];
  const catMeta = window.CATEGORY_META[rec.category];
  const strengthMeta = window.STRENGTH_META[rec.strength];

  const rootStr = window.TEAM_STRENGTHS[rec.rootFor]?.strengthScore || 0.5;
  const againstStr = window.TEAM_STRENGTHS[rec.against]?.strengthScore || 0.5;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="detail" onClick={(e) => e.stopPropagation()} style={{ position: "relative" }}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <div className="detail-head">
          <div>
            <div className="eyebrow">Game detail · {rec.kickoff} · {rec.network}</div>
            <h2>Why this game matters</h2>
          </div>
        </div>

        <div className="detail-tags">
          {rec.category && rec.score > 0.001 && (
            <span className={"strength-badge large tone-" + (catMeta?.tone || "muted")}>
              <span className="dot" style={{ background: strengthMeta?.color }}></span>
              <span className="strength-label mono">{strengthMeta?.label || ""}</span>
              <span className="strength-sep">·</span>
              <span className="strength-category">{catMeta?.label || rec.category}</span>
            </span>
          )}
          {rec.underdog === rec.rootFor && (
            <span className="under-tag">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7"/>
              </svg>
              Underdog pick
            </span>
          )}
          {rec.spread != null && (
            <span className="strength-badge tone-muted" title="Vegas spread">
              <span className="mono">Line {rec.spread > 0 ? `+${rec.spread}` : rec.spread}</span>
            </span>
          )}
        </div>

        <div className="matchup-large">
          <div className="side">
            <div className="badge" style={{ background: root.color }}>{rec.rootFor}</div>
            <div className="city">{root.city} {root.name}</div>
            <div className="record">{root.record[0]}-{root.record[1]} · {root.conf} {root.div}</div>
            <div className="detail-strength">
              <span className="mono lbl">Strength Rating</span>
              <div className="ds-track"><div className="ds-fill" style={{ width: `${rootStr * 100}%` }}></div></div>
              <span className="mono">{(rootStr * 100).toFixed(0)}</span>
            </div>
            <div className="label-pill root">Root for</div>
          </div>
          <div className="vs">VS</div>
          <div className="side">
            <div className="badge against">{rec.against}</div>
            <div className="city" style={{ color: "var(--text-muted)" }}>{against.city} {against.name}</div>
            <div className="record">{against.record[0]}-{against.record[1]} · {against.conf} {against.div}</div>
            <div className="detail-strength">
              <span className="mono lbl">Strength Rating</span>
              <div className="ds-track"><div className="ds-fill" style={{ width: `${againstStr * 100}%` }}></div></div>
              <span className="mono">{(againstStr * 100).toFixed(0)}</span>
            </div>
            <div className="label-pill against">Against</div>
          </div>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Reasoning</div>
          <div className="reasons">
            {reasons.map((r, i) => (
              <div className="reason" key={i}>
                <span className="num">{(i + 1).toString().padStart(2, "0")}</span>
                <span className="text">{r.charAt(0).toUpperCase() + r.slice(1)}.</span>
              </div>
            ))}
          </div>
        </div>

        <div className="scoremeter">
          <div className="row">
            <span>Impact score</span>
            <span className="v">{rec.score.toFixed(3)} <span style={{ color: "var(--text-faint)" }}>/ 1.000</span></span>
          </div>
          <div className="score-bar"><div className="fill" style={{ width: `${rec.score * 100}%` }}></div></div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>LOW</span>
            <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>HIGH</span>
          </div>
        </div>

        <div style={{ marginTop: 22, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

window.GameDetail = GameDetail;
