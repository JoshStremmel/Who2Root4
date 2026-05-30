/* Schedule grid — this week's games grouped by broadcast slot. */

function PrintView({ recs, fav, onClose, mode }) {
  const byId = {};
  recs.forEach(r => { byId[r.gameId] = r; });

  const favTeam = window.TEAMS[fav];
  const slotOrder = ["TNF", "Fri", "Sat", "Early", "Late", "SNF", "MNF", "Reg", "TBD"];
  const slotLabels = {
    TNF: "Thursday Night", Fri: "Friday", Sat: "Saturday",
    Early: "Sunday Early", Late: "Sunday Late",
    SNF: "Sunday Night", MNF: "Monday Night", Reg: "Other", TBD: "TBD",
  };

  const grouped = {};
  for (const g of window.SCHEDULE) {
    const key = slotOrder.includes(g.slot) ? g.slot : "Reg";
    (grouped[key] = grouped[key] || []).push(g);
  }
  const slots = slotOrder.filter(s => (grouped[s] || []).length);

  return (
    <div className="pv-overlay" onClick={onClose}>
      <div className="pv-sheet" onClick={e => e.stopPropagation()}>

        {/* Toolbar — hidden when printing */}
        <div className="pv-toolbar no-print">
          <span className="pv-meta">
            {window.WEEK_META.label} · {window.WEEK_META.season} · <strong>{favTeam.name}</strong> perspective
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => window.print()}>Print</button>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        {/* Print-only heading */}
        <div className="pv-print-head print-only">
          <div style={{ fontWeight: 700, fontSize: 18 }}>{window.WEEK_META.label} · {window.WEEK_META.season}</div>
          <div style={{ color: "#555", fontSize: 13 }}>Who to Root For — {favTeam.name} perspective</div>
        </div>

        <table className="pv-table">
          <thead>
            <tr>
              <th>Kickoff</th>
              <th>Matchup</th>
              <th>Root for</th>
              <th>Impact</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {slots.flatMap(slot => {
              const games = grouped[slot] || [];
              return [
                <tr key={`slot-${slot}`} className="pv-slot-row">
                  <td colSpan={5}>{slotLabels[slot]}</td>
                </tr>,
                ...games.map(g => {
                  const rec = byId[g.id];
                  const isOwn = g.home === fav || g.away === fav;
                  const hasImpact = rec && rec.score > 0.001;
                  const rootFor = rec?.rootFor;
                  const oppAbbr = isOwn ? (g.home === fav ? g.away : g.home) : null;
                  return (
                    <tr key={g.id} className={isOwn ? "pv-own" : hasImpact ? "pv-hit" : "pv-miss"}>
                      <td className="pv-time mono">{g.kickoff}</td>
                      <td className="pv-teams">
                        <span className={rootFor === g.away ? "pv-root" : ""}>{g.away}</span>
                        <span className="pv-at"> @ </span>
                        <span className={rootFor === g.home ? "pv-root" : ""}>{g.home}</span>
                      </td>
                      <td className="pv-pick">
                        {isOwn
                          ? <span className="pv-you">YOU</span>
                          : hasImpact
                            ? <span className="pv-root">{rootFor}</span>
                            : <span className="pv-dash">—</span>}
                      </td>
                      <td className="pv-score mono">
                        {isOwn ? "" : hasImpact ? rec.score.toFixed(2) : "—"}
                      </td>
                      <td className="pv-reason">
                        {isOwn
                          ? `${favTeam.abbr} ${g.home === fav ? "vs" : "@"} ${window.TEAMS[oppAbbr]?.abbr}`
                          : hasImpact && rec.reasoning
                            ? rec.reasoning.charAt(0).toUpperCase() + rec.reasoning.slice(1)
                            : ""}
                      </td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ScheduleCard({ game, rec, fav, onOpen, delay, mode }) {
  const home = window.TEAMS[game.home];
  const away = window.TEAMS[game.away];
  const isOwn = game.home === fav || game.away === fav;
  const rootFor = rec ? rec.rootFor : null;
  const completed = !!game.completed;
  const winner = game.winner; // 'home' | 'away' | 'tie' | null
  const tankMode = mode === "tank";

  // For "own team color visible" treatment: in tank mode, color comes from the opponent
  // (the team you're rooting FOR in tank). Otherwise it's your own team's color.
  const ownColor = isOwn
    ? (tankMode
        ? window.TEAMS[game.home === fav ? game.away : game.home].color
        : window.TEAMS[fav].color)
    : null;

  // Compute own-game impact score (1.0 by default, 0 if eliminated/clinched-out)
  const ownImpact = isOwn && !completed && typeof window.ownGameImpact === "function"
    ? window.ownGameImpact(fav, mode)
    : 0;

  // Synthetic rec for own-team game when no rec exists, so clicking opens details
  const ownSyntheticRec = isOwn && !rec && !completed ? {
    gameId: `${game.away}-${game.home}-own`,
    kickoff: game.kickoff,
    network: game.network,
    rootFor: tankMode ? (game.home === fav ? game.away : game.home) : fav,
    against: tankMode ? fav : (game.home === fav ? game.away : game.home),
    reasoning: `${window.TEAMS[fav].name} ${game.home === fav ? "host" : "visit"} ${window.TEAMS[game.home === fav ? game.away : game.home].name}.`,
    reasonsAll: [`${window.TEAMS[fav].name} ${game.home === fav ? "host" : "visit"} ${window.TEAMS[game.home === fav ? game.away : game.home].name}.`],
    score: ownImpact,
    category: "",
    strength: ownImpact >= 0.9 ? "high" : ownImpact > 0 ? "medium" : "low",
    home: game.home,
    away: game.away,
  } : null;
  const effectiveRec = rec || ownSyntheticRec;

  const renderTeam = (abbr, side) => {
    const t = window.TEAMS[abbr];
    const isRoot = rootFor === abbr;
    const isFav = abbr === fav;
    const score = side === "home" ? game.homeScore : game.awayScore;
    const isWinner = completed && winner === side;
    const isLoser = completed && winner && winner !== side && winner !== "tie";
    // Circle is colored for: root picks, completed winners, fav team (non-tank), tank opponent
    const isTankOpp = isOwn && tankMode && !isFav;
    const dotColored = isRoot || isWinner || (isFav && !tankMode) || isTankOpp;
    return (
      <div className={"team-row" + (isRoot && !completed ? " recommended" : "")}>
        <div className="left">
          <div className={"dot" + (dotColored ? "" : " muted")} style={dotColored ? { background: t.color } : null}></div>
          <span className="abbr">{abbr}</span>
          <span className="name">{t.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isRoot && !completed && <span className="rec-tag">Root</span>}
          {isFav && <span className="rec-tag own-tag">You</span>}
          {completed && score != null ?
          <span className={"score" + (isLoser ? " loser" : "")}>{score}</span> :

          <span className="record mono">{t.record[0]}-{t.record[1]}</span>
          }
        </div>
      </div>);

  };
  return (
    <button className={"sched-card" + (isOwn ? " own" : "") + (isOwn && tankMode ? " tank-mode" : "") + (completed ? " completed" : "")}
    onClick={() => effectiveRec && !completed ? onOpen(effectiveRec) : null}
    style={{ "--enter-delay": `${delay || 0}ms`, "--own-color": ownColor || undefined }}>
      <div className="top">
        <span>{game.kickoff}</span>
        <span>{game.network}</span>
      </div>
      <div className="matchup-row">
        {renderTeam(game.away, "away")}
        {renderTeam(game.home, "home")}
      </div>
      {completed ?
      <div className="final-row">
          <span>Final{winner === "tie" ? " · Tie" : ""}</span>
          <span className="mono" style={{ color: "var(--text-muted)" }}>
            {winner === "tie" ? "—" : `${window.TEAMS[winner === "home" ? game.home : game.away].abbr} won`}
          </span>
        </div> :
      effectiveRec ?
      <div className="footer">
          <span>Impact</span>
          <span className="mono" style={{ color: "var(--accent-ink)" }}>{effectiveRec.score.toFixed(2)}</span>
        </div> :
      isOwn ?
      <div className="footer">
          <span style={{ color: tankMode ? "var(--text-muted)" : "var(--accent-ink)" }}>
            {tankMode ? "Your team plays · root against" : "Your team plays"}
          </span>
          <span className="mono" style={{ color: "var(--text-muted)" }}>—</span>
        </div> :

      <div className="footer">
          <span>No impact</span>
          <span className="mono" style={{ color: "var(--text-muted)" }}>0.00</span>
        </div>
      }
    </button>);

}

function Schedule({ recs, fav, onOpenDetail, mode, setMode }) {
  const byId = {};
  recs.forEach((r) => {byId[r.gameId] = r;});
  const [printOpen, setPrintOpen] = React.useState(false);

  // Group by slot — render any slot that has games (handles Fri/Sat specials)
  const slotOrder = ["TNF", "Fri", "Sat", "Early", "Late", "SNF", "MNF", "Reg", "TBD"];
  const slotLabels = {
    TNF: "Thursday Night",
    Fri: "Friday",
    Sat: "Saturday",
    Early: "Sunday · Early window",
    Late: "Sunday · Late window",
    SNF: "Sunday Night",
    MNF: "Monday Night",
    Reg: "Other",
    TBD: "TBD"
  };

  const grouped = {};
  for (const g of window.SCHEDULE) {
    const key = slotOrder.includes(g.slot) ? g.slot : "Reg";
    (grouped[key] = grouped[key] || []).push(g);
  }
  const slots = slotOrder.filter((s) => (grouped[s] || []).length);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{window.WEEK_META.label} · {window.WEEK_META.season}</div>
          <h1>This week's schedule</h1>
          <div className="sub">
            Every game this week. Highlights show who to root for from a {window.TEAMS[fav].name} perspective.
          </div>
        </div>
        <button className="btn ghost" onClick={() => setPrintOpen(true)} style={{ flexShrink: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: "middle" }}>
            <polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>
          </svg>
          Print view
        </button>
      </div>

      {setMode && window.ModeSelector &&
        <window.ModeSelector favAbbr={fav} mode={mode} setMode={setMode} />
      }

      {slots.map((slot, sIdx) => {
        const games = grouped[slot] || [];
        if (!games.length) return null;
        return (
          <div className="slot-section" key={slot}
          style={{ "--section-delay": `${sIdx * 80}ms` }}>
            <h3>{slotLabels[slot]} <span className="line"></span><span className="mono">{games.length} game{games.length === 1 ? "" : "s"}</span></h3>
            <div className="sched-grid">
              {games.map((g, i) =>
              <ScheduleCard key={g.id} game={g} rec={byId[g.id]} fav={fav}
              onOpen={onOpenDetail}
              delay={sIdx * 80 + i * 40}
              mode={mode} />
              )}
            </div>
          </div>);

      })}

      {printOpen && <PrintView recs={recs} fav={fav} mode={mode} onClose={() => setPrintOpen(false)} />}
    </>);

}

window.Schedule = Schedule;
