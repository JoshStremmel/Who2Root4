/* Scenarios — clinch + elimination paths for the user's team. */

function LikelihoodRing({ value, size = 56 }) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * value;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="lk-ring">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="color-mix(in oklch, var(--text) 8%, transparent)"
              strokeWidth={stroke} fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--accent)"
              strokeWidth={stroke} fill="none" strokeLinecap="round"
              strokeDasharray={`${dash} ${c}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle"
            className="lk-ring-num" fontSize={size * 0.28} fontFamily="var(--font-mono)"
            fill="var(--text)">{Math.round(value * 100)}%</text>
    </svg>
  );
}

function ReqRow({ r, i }) {
  const t = window.TEAMS[r.team];
  const isWin = r.type === "win";
  const isAnyWeek = typeof r.week === "string" && /any|remaining/i.test(r.week);
  return (
    <div className="req-row" style={{ "--enter-delay": `${i * 50}ms` }}>
      <div className={"req-icon " + (isWin ? "win" : "loss")}>
        {isWin ? "✓" : "✗"}
      </div>
      <div className="req-team">
        <span className="dot" style={{ background: t.color }}></span>
        <span className="req-team-name">
          <strong className="mono">{r.team}</strong> {isWin ? "wins" : "loses"}
        </span>
      </div>
      <div className="req-rationale">
        <span className="req-rationale-text">{r.rationale}</span>
        <span className={"req-week" + (isAnyWeek ? " any" : "")} title={isAnyWeek ? "Any remaining week — order doesn't matter" : "Required week"}>
          {r.week}
        </span>
      </div>
    </div>
  );
}

function ScenarioCard({ s, idx }) {
  const tone = s.kind === "elimination" || s.kind === "eliminated" ? "danger"
             : s.kind === "watch"                                   ? "neutral"
             : "good";
  const urgencyLabel = s.isClinched  ? (s.kind === "eliminated" ? "Eliminated" : "Clinched ✓")
                     : { high: "High urgency", med: "Medium", low: "Low" }[s.urgency] || "—";
  return (
    <article className={"scn-card tone-" + tone} style={{ "--enter-delay": `${idx * 80}ms` }}>
      <header className="scn-head">
        <div>
          <div className={"scn-kind tag-" + tone}>
            {s.kind === "eliminated"  ? "Eliminated"
              : s.kind === "clinched" ? "Clinched"
              : s.kind === "elimination" ? "Elimination path"
              : s.kind === "watch"       ? "Race to watch"
              : "Clinch path"}
          </div>
          <h3 className="scn-title">{s.title}</h3>
          <p className="scn-summary">{s.summary}</p>
        </div>
        <div className="scn-likelihood">
          <LikelihoodRing value={s.likelihood} />
          <span className="scn-urgency mono">{urgencyLabel}</span>
        </div>
      </header>
      <div className="scn-divider">
        <span className="mono">Requirements · {s.requires.length}</span>
        <span className="line"></span>
      </div>
      <div className="scn-reqs">
        {s.requires.map((r, i) => <ReqRow key={i} r={r} i={i} />)}
      </div>
    </article>
  );
}

function Scenarios({ fav }) {
  const scenarios = window.computeScenarios(fav);
  const favTeam = window.TEAMS[fav];
  const clinch = scenarios.filter(s => s.kind === "clinch" || s.kind === "clinched");
  const watch  = scenarios.filter(s => s.kind === "watch");
  const elim   = scenarios.filter(s => s.kind === "elimination" || s.kind === "eliminated");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{favTeam.conf} {favTeam.div} · {favTeam.record[0]}-{favTeam.record[1]}</div>
          <h1>Playoff scenarios</h1>
          <div className="sub">
            Every path that gets the <strong>{favTeam.name}</strong> in — and every one that knocks them out.
            Requirements show win counts and rival record thresholds, not specific weeks.
          </div>
        </div>
      </div>

      {clinch.length > 0 && (
        <section className="scn-section">
          <h2 className="scn-section-title">
            <span className="scn-section-dot good"></span>
            Clinch paths <span className="scn-section-count mono">{clinch.length}</span>
          </h2>
          <div className="scn-grid">
            {clinch.map((s, i) => <ScenarioCard key={s.id} s={s} idx={i} />)}
          </div>
        </section>
      )}

      {watch.length > 0 && (
        <section className="scn-section">
          <h2 className="scn-section-title">
            <span className="scn-section-dot neutral"></span>
            Races to watch <span className="scn-section-count mono">{watch.length}</span>
          </h2>
          <div className="scn-grid">
            {watch.map((s, i) => <ScenarioCard key={s.id} s={s} idx={i} />)}
          </div>
        </section>
      )}

      {elim.length > 0 && (
        <section className="scn-section">
          <h2 className="scn-section-title">
            <span className="scn-section-dot danger"></span>
            Elimination watch <span className="scn-section-count mono">{elim.length}</span>
          </h2>
          <div className="scn-grid">
            {elim.map((s, i) => <ScenarioCard key={s.id} s={s} idx={i} />)}
          </div>
        </section>
      )}
    </>
  );
}

window.Scenarios = Scenarios;
