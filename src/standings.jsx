/* Standings — division tables + playoff seeding sidebar. */

function SeedDot({ kind, seed }) {
  const label = kind === "division" ? "DIV" : "WC";
  const bg = kind === "division" ? "var(--accent)" : "color-mix(in oklch, var(--accent) 55%, var(--text-faint))";
  return (
    <span className="seed-pill" style={{ background: bg }}>
      {seed}
      <span className="seed-kind">{label}</span>
    </span>
  );
}

function DivisionTable({ conf, div, teams, fav, seeds }) {
  return (
    <div className="div-table">
      <div className="div-table-head">
        <h3>{conf} {div}</h3>
        <span className="mono">{teams.length} teams</span>
      </div>
      <div className="div-table-rows">
        {teams.map((t, i) => {
          const s = seeds.byTeam[t.abbr];
          const isFav = t.abbr === fav;
          const inPlayoffs = s && s.seed && s.seed <= 7;
          const strength = window.TEAM_STRENGTHS[t.abbr]?.strengthScore || 0.5;
          const tb = window.TIEBREAKER_REASONS[t.abbr];
          return (
            <div className={"div-row" + (isFav ? " is-fav" : "")} key={t.abbr}
                 style={{ "--enter-delay": `${i * 30}ms` }}>
              <div className="rank mono">{i + 1}</div>
              <div className="swatch" style={{ background: t.color }}></div>
              <div className="name">
                <span className="city">{t.city}</span>
                <span className="team-name">{t.name}</span>
                {tb && (
                  <span className="tb-tag" title={`Tiebreaker over ${tb.over.join(", ")}: ${tb.reason}`}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18l6-6-6-6"/>
                    </svg>
                    TB
                  </span>
                )}
              </div>
              <div className="record mono">
                {t.record[0]}-{t.record[1]}
              </div>
              <div className="strength-cell">
                <div className="strength-track"><div className="strength-fill" style={{ width: `${strength * 100}%` }}></div></div>
                <span className="mono">{(strength * 100).toFixed(0)}</span>
              </div>
              <div className="seed-cell">
                {inPlayoffs && <SeedDot kind={s.kind} seed={s.seed} />}
                {!inPlayoffs && s && s.gamesBehind != null && (
                  <span className="gb mono">{s.gamesBehind} GB</span>
                )}
                {isFav && <span className="you-tag">You</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfBracket({ conf, seeds, fav }) {
  // First three teams out of the wild-card race — same conference, no seed,
  // sorted by win pct descending (computeStandings already orders rest by pct).
  const teamsOut = Object.entries(seeds.byTeam)
    .filter(([, s]) => s.kind === "out" && s.conf === conf)
    .map(([abbr, s]) => ({ abbr, ...s, team: window.TEAMS[abbr] }))
    .sort((a, b) => {
      const aP = a.team.record[0] / Math.max(1, a.team.record[0] + a.team.record[1]);
      const bP = b.team.record[0] / Math.max(1, b.team.record[0] + b.team.record[1]);
      return bP - aP || b.team.record[0] - a.team.record[0];
    })
    .slice(0, 3);

  return (
    <div className="bracket-card">
      <div className="bracket-head">
        <h4>{conf} Playoff Picture</h4>
        <span className="mono">7 of 16</span>
      </div>
      <ol className="bracket-list">
        {seeds[conf].map((s) => {
          const t = window.TEAMS[s.team];
          const isFav = s.team === fav;
          return (
            <li key={s.team} className={"bracket-row" + (isFav ? " is-fav" : "")
                                       + (s.kind === "division" ? " div-winner" : "")}>
              <span className="bracket-seed mono">{s.seed}</span>
              <span className="bracket-swatch" style={{ background: t.color }}></span>
              <span className="bracket-name">
                <span className="city">{t.city}</span> <span className="team-name">{t.name}</span>
              </span>
              <span className="bracket-record mono">{t.record[0]}-{t.record[1]}</span>
              <span className={"bracket-kind" + (s.kind === "division" ? " is-div" : " is-wc")}>
                {s.kind === "division" ? "Division" : "Wild card"}
              </span>
            </li>
          );
        })}
        <li className="bracket-divider">
          <span className="line"></span>
          <span className="cutoff mono">playoff cutoff</span>
          <span className="line"></span>
        </li>
        {teamsOut.length > 0 ? teamsOut.map((o, i) => {
          const isFav = o.abbr === fav;
          return (
            <li key={o.abbr}
                className={"bracket-row bubble-row" + (i === 0 ? " first-out" : "") + (isFav ? " is-fav" : "")}>
              <span className="bracket-seed mono">{8 + i}</span>
              <span className="bracket-swatch" style={{ background: o.team.color }}></span>
              <span className="bracket-name">
                <span className="city">{o.team.city}</span> <span className="team-name">{o.team.name}</span>
              </span>
              <span className="bracket-record mono">{o.team.record[0]}-{o.team.record[1]}</span>
              <span className="bracket-kind">
                {i === 0 ? "First out" : i === 1 ? "Second out" : "Third out"}
              </span>
            </li>
          );
        }) : (
          <li className="bracket-row bubble-row">
            <span className="bracket-seed mono">8</span>
            <span className="bracket-swatch muted"></span>
            <span className="bracket-name muted">No teams currently out</span>
            <span className="bracket-record mono">—</span>
          </li>
        )}
      </ol>
    </div>
  );
}

function Standings({ fav }) {
  const seeds = window.computeStandings();
  const order = ["East", "North", "South", "West"];
  const favTeam = window.TEAMS[fav];
  const favSeed = seeds.byTeam[fav];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{window.WEEK_META.label} · {window.WEEK_META.season} standings</div>
          <h1>Standings &amp; seeding</h1>
          <div className="sub">
            {favSeed && favSeed.seed
              ? <>The {favTeam.name} sit at the <strong className="mono">#{favSeed.seed}</strong> seed — currently in as a {favSeed.kind === "division" ? "division leader" : "wild card"}.</>
              : <>The {favTeam.name} are on the outside looking in by {favSeed?.gamesBehind} game{favSeed?.gamesBehind === 1 ? "" : "s"}.</>}
          </div>
        </div>
      </div>

      <div className="standings-grid">
        <div className="standings-divisions">
          {["AFC", "NFC"].map((conf, ci) => (
            <div key={conf} className="conf-block"
                 style={{ "--section-delay": `${ci * 80}ms` }}>
              <h2 className="conf-title">{conf}</h2>
              <div className="div-tables">
                {order.map(div => (
                  <DivisionTable
                    key={div}
                    conf={conf}
                    div={div}
                    teams={seeds.divisions[conf][div]}
                    fav={fav}
                    seeds={seeds}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <aside className="standings-side">
          <ConfBracket conf={favTeam.conf} seeds={seeds} fav={fav} />
          <ConfBracket conf={favTeam.conf === "AFC" ? "NFC" : "AFC"} seeds={seeds} fav={fav} />

          <div className="tb-panel">
            <div className="bracket-head">
              <h4>Tiebreakers resolved</h4>
              <span className="mono">{Object.keys(window.TIEBREAKER_REASONS).length}</span>
            </div>
            <div className="tb-list">
              {Object.entries(window.TIEBREAKER_REASONS).map(([abbr, tb]) => {
                const t = window.TEAMS[abbr];
                return (
                  <div className="tb-row" key={abbr}>
                    <span className="tb-swatch" style={{ background: t.color }}></span>
                    <span className="tb-team">
                      <span className="mono ab">{abbr}</span>
                      <span className="tb-over">over {tb.over.join(", ")}</span>
                    </span>
                    <span className="tb-reason">{tb.reason}</span>
                  </div>
                );
              })}
            </div>

            <div className="tb-procs">
              <div className="tb-proc-block">
                <div className="tb-proc-head">
                  <span className="tb-proc-tag div">DIV</span>
                  <span className="tb-proc-title">Divisional tie-breaker procedure</span>
                </div>
                <ol className="tb-proc-list">
                  <li className="lead">Head-to-head (best won-lost-tied % in games between the clubs)</li>
                  <li>Best won-lost-tied % in games played within the division</li>
                  <li>Best won-lost-tied % in common games</li>
                  <li>Best won-lost-tied % in games played within the conference</li>
                  <li>Strength of victory</li>
                  <li>Strength of schedule</li>
                  <li>Best combined ranking in conference points scored &amp; allowed</li>
                  <li>Best combined ranking in NFL points scored &amp; allowed</li>
                  <li>Best net points in common games</li>
                  <li>Best net points in all games</li>
                  <li>Best net touchdowns in all games</li>
                  <li>Coin toss</li>
                </ol>
              </div>

              <div className="tb-proc-block">
                <div className="tb-proc-head">
                  <span className="tb-proc-tag wc">WC</span>
                  <span className="tb-proc-title">Wild-card tie-breaker procedure</span>
                </div>
                <ol className="tb-proc-list">
                  <li className="lead">Apply divisional tie-breaker to eliminate all but the highest-ranked club in each division first</li>
                  <li>Head-to-head sweep (only if one club has beaten or lost to each of the others)</li>
                  <li>Best won-lost-tied % in games played within the conference</li>
                  <li>Best won-lost-tied % in common games (minimum of four)</li>
                  <li>Strength of victory</li>
                  <li>Strength of schedule</li>
                  <li>Best combined ranking in conference points scored &amp; allowed</li>
                  <li>Best combined ranking in NFL points scored &amp; allowed</li>
                  <li>Best net points in conference games</li>
                  <li>Best net points in all games</li>
                  <li>Best net touchdowns in all games</li>
                  <li>Coin toss</li>
                </ol>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

window.Standings = Standings;
