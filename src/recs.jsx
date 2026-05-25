/* "This Week" — hero rec, Your Game, mode selector, category/strength-aware cards. */

const { useState: useRecState, useMemo: useRecMemo, useEffect: useRecEffect, useRef: useRecRef } = React;

// Animate a number from 0 → target on mount.
function useCountUp(target, dur = 900, delay = 0) {
  const [v, setV] = useRecState(0);
  useRecEffect(() => {
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now) => {
      if (now < start) { raf = requestAnimationFrame(tick); return; }
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, dur, delay]);
  return v;
}

function useMouseFollow() {
  const ref = useRecRef(null);
  const onMove = () => {}; // disabled — orange hover light removed
  return [ref, onMove];
}

// ── Mode selector ──────────────────────────────────────────────────────────
function ModeSelector({ favAbbr, mode, setMode }) {
  const available = useRecMemo(() => new Set(window.availableModes(favAbbr)), [favAbbr]);
  return (
    <div className="mode-bar">
      <div className="mode-bar-label">
        <span className="mono">Goal</span>
      </div>
      <div className="mode-pills" role="tablist">
        {window.MODES.map((m) => {
          const enabled = available.has(m.id);
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              role="tab"
              aria-selected={active}
              disabled={!enabled}
              className={"mode-pill" + (active ? " active" : "") + (enabled ? "" : " disabled")}
              onClick={() => enabled && setMode(m.id)}
              title={enabled ? m.desc : `${m.label} is no longer mathematically reachable`}
            >
              {m.label}
              {!enabled && <span className="mode-lock" aria-hidden="true">·</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Strength badge ────────────────────────────────────────────────────────
function StrengthBadge({ strength, category }) {
  const meta = window.STRENGTH_META[strength];
  const catMeta = window.CATEGORY_META[category];
  if (!meta) return null;
  return (
    <span className={"strength-badge tone-" + (catMeta?.tone || "muted")}
          title={catMeta?.help}>
      <span className="dot" style={{ background: meta.color }}></span>
      <span className="strength-label mono">{meta.label}</span>
      <span className="strength-sep">·</span>
      <span className="strength-category">{catMeta?.label || category}</span>
    </span>
  );
}

// ── Your team's game (sticky/featured banner) ─────────────────────────────
function YourGame({ favAbbr, mode, onOpen }) {
  const data = useRecMemo(() => window.favTeamGame(favAbbr, mode), [favAbbr, mode]);
  if (!data) return null;
  const fav = window.TEAMS[data.fav];
  const opp = window.TEAMS[data.opp];
  const isFavUnderdog = data.underdog === fav.abbr;
  const isFinal = !!data.completed;
  const favWon = isFinal && data.won;
  const favTied = isFinal && data.tied;
  const favLost = isFinal && !data.won && !data.tied;

  // Build a rec-shaped object so the existing GameDetail overlay can render
  // your-own-game just like any other rec card.
  const ownRec = {
    gameId: data.id || `${data.away}-${data.home}-own`,
    kickoff: data.kickoff,
    network: data.network,
    rootFor: mode === "tank" ? data.opp : data.fav,
    against: mode === "tank" ? data.fav : data.opp,
    reasoning: data.blurb,
    reasonsAll: [data.blurb || `${fav.name} ${data.isHome ? "host" : "visit"} ${opp.name}.`],
    score: 1.0,
    category: "",
    strength: "high",
    underdog: data.underdog,
    spread: data.spread,
    home: data.home,
    away: data.away,
  };

  const clickable = !!onOpen;
  const handleClick = () => { if (clickable) onOpen(ownRec); };
  const handleKey = (e) => {
    if (!clickable) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(ownRec); }
  };

  return (
    <section
      className={"your-game" + (isFinal ? " final" : "") + (clickable ? " clickable" : "")}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKey}
      aria-label={clickable ? `Open details for ${fav.name} ${data.isHome ? "vs" : "at"} ${opp.name}` : undefined}
    >
      <div className="your-game-stripe" style={{ background: fav.color }}></div>
      <div className="your-game-inner">
        <div className="your-game-head">
          <div className="your-game-eyebrow">
            <span className="pulse-dot"></span>
            {isFinal ? (
              <>Last game · {data.kickoff} · {data.network}</>
            ) : (
              <>Your game · {data.kickoff} · {data.network}</>
            )}
          </div>
          <h2 className="your-game-title">
            {isFinal ? (
              <>
                {fav.name}{" "}
                <span style={{ color: favWon ? "var(--accent-ink)" : favTied ? "var(--text-muted)" : "var(--text-faint)" }}>
                  {favWon ? "beat" : favTied ? "tied" : "lost to"}
                </span>{" "}
                {opp.name}
              </>
            ) : (
              <>{fav.name} {data.isHome ? "vs" : "@"} {opp.name}</>
            )}
          </h2>
          <p className="your-game-blurb">{data.blurb}</p>
        </div>
        <div className="your-game-matchup">
          <div className="yg-side">
            <div className="yg-badge" style={{ background: fav.color }}>{fav.abbr}</div>
            {isFinal ? (
              <div className="yg-record mono" style={{ fontSize: 24, fontWeight: 700, color: favWon ? "var(--text)" : "var(--text-faint)" }}>{data.favScore}</div>
            ) : (
              <div className="yg-record mono">{fav.record[0]}-{fav.record[1]}</div>
            )}
            <div className="yg-label">
              You {!isFinal && isFavUnderdog && <span className="yg-under">underdog</span>}
              {isFinal && favWon && <span className="yg-under" style={{ background: "var(--accent-soft)", color: "var(--accent-ink)" }}>Won</span>}
              {isFinal && favLost && <span className="yg-under" style={{ background: "color-mix(in oklch, var(--text) 6%, transparent)", color: "var(--text-muted)" }}>Lost</span>}
            </div>
          </div>
          <div className="yg-vs">
            {isFinal ? (
              <div className="yg-spread mono" style={{ fontSize: 11 }}>FINAL</div>
            ) : data.spread != null ? (
              <div className="yg-spread mono">{data.spread > 0 ? `+${data.spread}` : data.spread}</div>
            ) : null}
            <span className="yg-vs-text">{data.isHome ? "VS" : "@"}</span>
          </div>
          <div className="yg-side">
            <div className="yg-badge against">{opp.abbr}</div>
            {isFinal ? (
              <div className="yg-record mono" style={{ fontSize: 24, fontWeight: 700, color: favLost ? "var(--text)" : "var(--text-faint)" }}>{data.oppScore}</div>
            ) : (
              <div className="yg-record mono">{opp.record[0]}-{opp.record[1]}</div>
            )}
            <div className="yg-label">{opp.city}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Hero rec ─────────────────────────────────────────────────────────────
function HeroRec({ rec, fav, onOpen, mode }) {
  const root = window.TEAMS[rec.rootFor];
  const against = window.TEAMS[rec.against];
  const score = useCountUp(rec.score, 1200, 200);
  const isPlayoffMath = mode !== "tank";

  return (
    <div className="hero-rec" role="button" onClick={() => onOpen(rec)}>
      <div>
        <div className="ribbon">
          <span className="pulse"></span> Top pick · Week {window.WEEK_META.week} · {window.MODES.find(m => m.id === mode).label}
        </div>
        <h2>
          Root for the <span className="root-team">{root.name}</span><br />
          against the {against.name}.
        </h2>
        <div className="hero-badges">
          <StrengthBadge strength={rec.strength} category={rec.category} />
          {rec.underdog === rec.rootFor && (
            <span className="under-tag">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7"/>
              </svg>
              Underdog pick
            </span>
          )}
        </div>
        <ul className="hero-reasons">
          {rec.reasonsAll.slice(0, 3).map((r, i) => (
            <li key={i}>{r.charAt(0).toUpperCase() + r.slice(1)}.</li>
          ))}
        </ul>
        <div className="stats">
          <div className="stat">
            <div className="k">{isPlayoffMath ? "Impact" : "Draft impact"}</div>
            <div className="v mono">{score.toFixed(2)}</div>
          </div>
          <div className="stat">
            <div className="k">Kickoff</div>
            <div className="v">{rec.kickoff.split(" ").slice(0, 2).join(" ")}</div>
          </div>
          <div className="stat">
            <div className="k">Network</div>
            <div className="v">{rec.network}</div>
          </div>
        </div>
      </div>
      <div className="visual">
        <div className="badge-big root" style={{ background: root.color }}>{rec.rootFor}</div>
        <div className="badge-big against">{rec.against}</div>
      </div>
    </div>
  );
}

// ── Rec card ─────────────────────────────────────────────────────────────
function RecCard({ rec, rank, onOpen, delay, mode }) {
  const root = window.TEAMS[rec.rootFor];
  const against = window.TEAMS[rec.against];
  const score = useCountUp(rec.score, 800, delay + 200);
  const [ref, onMove] = useMouseFollow();
  const noImpact = rec.score < 0.001;

  return (
    <button
      ref={ref}
      onMouseMove={onMove}
      className={"rec-card" + (noImpact ? " no-impact" : "")}
      onClick={() => onOpen(rec)}
      style={{ "--enter-delay": `${delay}ms` }}
    >
      <span className="rank rank-bare" aria-label={`Impact rank ${rank}`}>
        <span className="rank-num">{rank}</span>
      </span>
      <div className="meta">
        <span>{rec.kickoff}</span>
        <span className="dot"></span>
        <span>{rec.network}</span>
      </div>
      <div className="matchup">
        <div className="side">
          <div className="badge" style={{ background: root.color }}>
            {rec.rootFor}
            <span className="check">✓</span>
          </div>
          <div className="label" style={{ color: "var(--accent-ink)", fontWeight: 500 }}>Root for</div>
        </div>
        <div className="vs">
          {rec.spread != null && <span className="spread mono">{rec.spread > 0 ? `+${rec.spread}` : rec.spread}</span>}
          <span>VS</span>
        </div>
        <div className="side">
          <div className="badge against">{rec.against}</div>
          <div className="label">Against</div>
        </div>
      </div>
      <div className="rec-card-badges">
        {rec.category && <StrengthBadge strength={rec.strength} category={rec.category} />}
        {rec.underdog === rec.rootFor && (
          <span className="under-tag small">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7"/>
            </svg>
            Underdog
          </span>
        )}
      </div>
      <div className="reasoning">
        {rec.reasoning.charAt(0).toUpperCase() + rec.reasoning.slice(1)}.
      </div>
      <div className="score-row">
        <span className="impact-score-pill" aria-label={`Impact score ${score.toFixed(2)}`}>
          <span>Impact score</span>
          <span className="impact-score-num">{score.toFixed(2)}</span>
        </span>
      </div>
    </button>
  );
}

// ── Main view ────────────────────────────────────────────────────────────
function Recommendations({ recs, fav, dislikes, onOpenDetail, mode, setMode }) {
  const [filter, setFilter] = useRecState("all");

  const filtered = useRecMemo(() => {
    if (filter === "all") return recs;
    const f = window.TEAMS[fav];
    if (filter === "high")    return recs.filter(r => r.strength === "high");
    if (filter === "div")     return recs.filter(r => window.TEAMS[r.against].div === f.div && window.TEAMS[r.against].conf === f.conf);
    if (filter === "conf")    return recs.filter(r => window.TEAMS[r.against].conf === f.conf);
    if (filter === "dislike") return recs.filter(r => dislikes.includes(r.against));
    if (filter === "upset")   return recs.filter(r => r.underdog === r.rootFor);
    return recs;
  }, [recs, filter, fav, dislikes]);

  const top = filtered[0];
  const rest = filtered.slice(1);

  const counts = useRecMemo(() => {
    const f = window.TEAMS[fav];
    return {
      all:     recs.length,
      high:    recs.filter(r => r.strength === "high").length,
      div:     recs.filter(r => window.TEAMS[r.against].div === f.div).length,
      conf:    recs.filter(r => window.TEAMS[r.against].conf === f.conf).length,
      dislike: recs.filter(r => dislikes.includes(r.against)).length,
      upset:   recs.filter(r => r.underdog === r.rootFor).length,
    };
  }, [recs, fav, dislikes]);

  const favTeam = window.TEAMS[fav];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{window.WEEK_META.label} · {window.WEEK_META.season} · {favTeam.conf} {favTeam.div}</div>
          <h1>This week's rooting guide</h1>
          <div className="sub">
            {recs.length} games matter to the {favTeam.name}.
            Ranked by {mode === "tank" ? "draft impact" : "playoff impact"} for your selected goal.
          </div>
        </div>
      </div>

      <ModeSelector favAbbr={fav} mode={mode} setMode={setMode} />

      <YourGame favAbbr={fav} mode={mode} onOpen={onOpenDetail} />

      <div className="filter-row">
        <button className={"filter-chip" + (filter === "all" ? " active" : "")} onClick={() => setFilter("all")}>
          All games <span className="count">{counts.all}</span>
        </button>
        <button className={"filter-chip" + (filter === "high" ? " active" : "")} onClick={() => setFilter("high")}>
          High impact <span className="count">{counts.high}</span>
        </button>
        <button className={"filter-chip" + (filter === "div" ? " active" : "")} onClick={() => setFilter("div")}>
          Division rivals <span className="count">{counts.div}</span>
        </button>
        <button className={"filter-chip" + (filter === "conf" ? " active" : "")} onClick={() => setFilter("conf")}>
          Conference <span className="count">{counts.conf}</span>
        </button>
        {counts.upset > 0 && (
          <button className={"filter-chip" + (filter === "upset" ? " active" : "")} onClick={() => setFilter("upset")}>
            Upset picks <span className="count">{counts.upset}</span>
          </button>
        )}
        {dislikes.length > 0 && (
          <button className={"filter-chip" + (filter === "dislike" ? " active" : "")} onClick={() => setFilter("dislike")}>
            Dislikes <span className="count">{counts.dislike}</span>
          </button>
        )}
      </div>

      {!top ? (
        <div className="empty">No matching games this week.</div>
      ) : (
        <>
          <HeroRec rec={top} fav={fav} onOpen={onOpenDetail} mode={mode} />
          <div className="rec-grid">
            {rest.map((r, i) => (
              <RecCard key={r.gameId} rec={r} rank={i + 2} onOpen={onOpenDetail}
                       delay={150 + i * 60} mode={mode} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

window.Recommendations = Recommendations;
window.ModeSelector = ModeSelector;
