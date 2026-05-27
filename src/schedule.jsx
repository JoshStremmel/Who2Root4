/* Schedule grid — this week's games grouped by broadcast slot. */

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
    </>);

}

window.Schedule = Schedule;
