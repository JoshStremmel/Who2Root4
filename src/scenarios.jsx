/* Scenarios — clinch + elimination paths for the user's team. */

// Annotate each scenario's `requires` rows with a "when" label so users see
// which week each win/loss needs to land. Scenarios are matched by id; if a
// requirement isn't covered, it falls back to "Any remaining week".
function annotateWeeks(scenarios) {
  const W = (window.WEEK_META && window.WEEK_META.week) || 14;
  const map = {
    "clinch-div-quick": [`Week ${W}`, `Week ${W}`],
    "clinch-div-slow":  [`Week ${W}`, `Week ${W + 1}`],
    "catch-up":         [`Week ${W}`, "Any remaining week", "Any remaining week"],
    "wc-clinch":        [`Week ${W}`, "Any remaining week", "Any remaining week"],
    "elim-watch":       [`Week ${W}`, `Week ${W + 1}`, "Any remaining week"],
    "bye-chase":        ["Weeks remaining (all)", "Any remaining week"],
  };
  return scenarios.map((s) => {
    const labels = map[s.id];
    return {
      ...s,
      requires: s.requires.map((r, i) => ({
        ...r,
        week: r.week || (labels && labels[i]) || "Any remaining week",
      })),
    };
  });
}

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
  const tone = s.kind === "elimination" ? "danger"
             : s.kind === "watch"       ? "neutral"
             : "good";
  const urgencyLabel = { high: "High urgency", med: "Medium", low: "Low" }[s.urgency] || "—";
  return (
    <article className={"scn-card tone-" + tone} style={{ "--enter-delay": `${idx * 80}ms` }}>
      <header className="scn-head">
        <div>
          <div className={"scn-kind tag-" + tone}>
            {s.kind === "elimination" ? "Elimination path"
              : s.kind === "watch"   ? "Race to watch"
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
  const scenarios = annotateWeeks(window.computeScenarios(fav));
  const favTeam = window.TEAMS[fav];
  const clinch = scenarios.filter(s => s.kind === "clinch");
  const watch  = scenarios.filter(s => s.kind === "watch");
  const elim   = scenarios.filter(s => s.kind === "elimination");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{favTeam.conf} {favTeam.div} · {favTeam.record[0]}-{favTeam.record[1]}</div>
          <h1>Playoff scenarios</h1>
          <div className="sub">
            Every path that gets the <strong>{favTeam.name}</strong> in — and every one that knocks them out.
            Each requirement is tagged with the week it needs to land.
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
