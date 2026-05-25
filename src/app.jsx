/* App shell + state management for Who2Root4. */

const { useState: useAppState, useEffect: useAppEffect, useRef: useAppRef, useMemo: useAppMemo } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "favTeam": "PIT",
  "dislikes": ["BAL", "CIN"],
  "mode": "overall"
} /*EDITMODE-END*/;

function TopNav({ tab, setTab, fav, setFav, theme, setTheme, onOpenOnboarding, user, onLogout }) {
  const [open, setOpen] = useAppState(false);
  const [userOpen, setUserOpen] = useAppState(false);
  const menuRef = useAppRef(null);
  const userMenuRef = useAppRef(null);

  useAppEffect(() => {
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserOpen(false);
    };
    if (open || userOpen) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, userOpen]);

  const t = window.TEAMS[fav];
  const initials = (user?.name || "?").split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();

  return (
    <header className="topnav">
      <div className="brand">
        <span className="brand-word">Who2Root4</span>
        <span style={{ color: "var(--text-faint)", marginLeft: 6, fontFamily: "var(--font-data)", fontWeight: 400, fontSize: 13, letterSpacing: 0, textTransform: "none", opacity: 0.85 }}>· {window.WEEK_META.label}</span>
      </div>

      <nav className="tabs">
        <button className={"tab" + (tab === "recs" ? " active" : "")} onClick={() => setTab("recs")}>
          This Week
        </button>
        <button className={"tab" + (tab === "schedule" ? " active" : "")} onClick={() => setTab("schedule")}>
          Schedule
        </button>
        <button className={"tab" + (tab === "standings" ? " active" : "")} onClick={() => setTab("standings")}>
          Standings
        </button>
        <button className={"tab" + (tab === "scenarios" ? " active" : "")} onClick={() => setTab("scenarios")}>
          Scenarios
        </button>
      </nav>

      <div className="right">
        <div className="position-rel" ref={menuRef}>
          <button className="team-chip" onClick={() => setOpen(!open)}>
            <span className="pill" style={{ background: t.color }}>{fav}</span>
            <span>{t.name}</span>
            <span className="caret">▾</span>
          </button>
          {open &&
          <div className="team-menu">
              <div style={{ borderBottom: "1px solid var(--border)", marginBottom: 8, paddingBottom: 6 }}>
                <button className="item" onClick={() => {setOpen(false);onOpenOnboarding();}}>
                  <span style={{ width: 14, display: "inline-grid", placeItems: "center", fontSize: 14 }}>⚙</span>
                  <span>Edit team &amp; rivals</span>
                </button>
              </div>
              {["AFC East", "AFC North", "AFC South", "AFC West", "NFC East", "NFC North", "NFC South", "NFC West"].map((div) => {
              const [conf, divName] = div.split(" ");
              const abbrs = window.TEAMS_BY_DIVISION[`${conf} ${divName}`] || [];
              return (
                <React.Fragment key={div}>
                    <h5>{conf} {divName}</h5>
                    {abbrs.map((abbr) => {
                    const team = window.TEAMS[abbr];
                    return (
                      <button
                        key={abbr}
                        className={"item" + (abbr === fav ? " current" : "")}
                        onClick={() => {setFav(abbr);setOpen(false);}}>
                        
                          <span className="swatch" style={{ background: team.color }}></span>
                          <span>{team.name}</span>
                          <span className="ab">{team.abbr}</span>
                        </button>);

                  })}
                  </React.Fragment>);

            })}
            </div>}
        </div>

        <div className="position-rel" ref={userMenuRef}>
          <button className="user-chip" onClick={() => setUserOpen(!userOpen)}>
            <span className="avatar">{initials}</span>
            <span>{(user?.name || "Account").split(" ")[0]}</span>
            <span className="caret">▾</span>
          </button>
          {userOpen &&
          <div className="user-menu">
              <div className="who">
                <div className="name">{user?.name}</div>
                <div className="email">
                  {user?.isGuest ? "Browsing as guest" : user?.email}
                </div>
              </div>
              {user?.isGuest &&
            <button className="item" onClick={() => {setUserOpen(false);onLogout();}}
            style={{ color: "var(--accent-ink)" }}>
                  <span style={{ width: 14, display: "inline-grid", placeItems: "center" }}>＋</span>
                  Sign up to save your team
                </button>
            }
              <button className="item" onClick={() => {setUserOpen(false);onOpenOnboarding();}}>
                <span style={{ width: 14, display: "inline-grid", placeItems: "center" }}>⚙</span>
                Edit team & rivals
              </button>
              <button className="item danger" onClick={() => {setUserOpen(false);onLogout();}}>
                <span style={{ width: 14, display: "inline-grid", placeItems: "center" }}>↩</span>
                {user?.isGuest ? "Exit guest mode" : "Log out"}
              </button>
            </div>
          }
        </div>

        <button
          className="icon-btn"
          aria-label="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title="Toggle theme">
          
          {theme === "dark" ?
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </svg> :

          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          }
        </button>
      </div>
    </header>);

}

function App() {
  const [tw, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [tab, setTab] = useAppState("recs");
  const [detail, setDetail] = useAppState(null);
  // Auth + onboarding state. Session is hydrated from localStorage on first render
  // so a logged-in user lands on home; a new user gets the auth screen first.
  const [user, setUser] = useAppState(() => window.W2R4_Auth.loadSession());
  const [onboarding, setOnboarding] = useAppState(false);

  useAppEffect(() => {
    document.documentElement.setAttribute("data-theme", tw.theme);
  }, [tw.theme]);

  const recs = useAppMemo(
    () => window.computeRecommendations(tw.favTeam, tw.dislikes, tw.mode || "overall"),
    [tw.favTeam, tw.dislikes, tw.mode]
  );

  // If the current mode becomes unreachable (e.g., user switches team), reset to overall.
  useAppEffect(() => {
    const allowed = new Set(window.availableModes(tw.favTeam));
    if (!allowed.has(tw.mode || "overall")) setTweak("mode", "overall");
  }, [tw.favTeam]);

  const handleAuthed = (u) => {
    setUser(u);
    // New user → run onboarding. Returning user → straight to home.
    if (!u.onboarded) setOnboarding(true);
  };

  const finishOnboarding = (favAbbr, dislikes) => {
    setTweak({ favTeam: favAbbr, dislikes });
    // Mark this user as onboarded in both the session blob and the users table
    if (user) {
      const updatedSession = { ...user, onboarded: true };
      window.W2R4_Auth.saveSession(updatedSession);
      const users = window.W2R4_Auth.loadUsers();
      if (users[user.email]) {
        users[user.email].onboarded = true;
        window.W2R4_Auth.saveUsers(users);
      }
      setUser(updatedSession);
    }
    setOnboarding(false);
  };

  const handleLogout = () => {
    window.W2R4_Auth.clearSession();
    setUser(null);
    setOnboarding(false);
    setTab("recs");
  };

  // Routing: auth → onboarding → home
  if (!user) {
    return <window.Auth onAuthed={handleAuthed} />;
  }
  if (onboarding) {
    return <window.Onboarding onFinish={finishOnboarding} />;
  }

  return (
    <div className="app">
      {tw && window.WEEK_META?.simWeek &&
      <div className="dev-banner">
          <span>● Dev mode</span>
          <strong>Simulating Week {window.WEEK_META.simWeek}, 2025 — games this week and beyond are pending</strong>
          <button onClick={() => {localStorage.removeItem("w2r4_sim_week");location.reload();}}>
            Exit
          </button>
        </div>
      }
      <TopNav
        tab={tab}
        setTab={setTab}
        fav={tw.favTeam}
        setFav={(abbr) => setTweak("favTeam", abbr)}
        theme={tw.theme}
        setTheme={(t) => setTweak("theme", t)}
        onOpenOnboarding={() => setOnboarding(true)}
        user={user}
        onLogout={handleLogout} />
      
      <main className="main" key={tab}>
        {tab === "recs" &&
        <window.Recommendations
          recs={recs}
          fav={tw.favTeam}
          dislikes={tw.dislikes}
          onOpenDetail={setDetail}
          mode={tw.mode || "overall"}
          setMode={(m) => setTweak("mode", m)} />

        }
        {tab === "schedule" &&
        <window.Schedule
          recs={recs}
          fav={tw.favTeam}
          onOpenDetail={setDetail}
          mode={tw.mode || "overall"}
          setMode={(m) => setTweak("mode", m)} />

        }
        {tab === "standings" &&
        <window.Standings fav={tw.favTeam} />
        }
        {tab === "scenarios" &&
        <window.Scenarios fav={tw.favTeam} />
        }
      </main>

      {detail &&
      <window.GameDetail rec={detail} fav={tw.favTeam} onClose={() => setDetail(null)} />
      }

      <footer className="w2r4-source-footer">
        Data pulled live from{" "}
        <a href={window.W2R4_SOURCE?.url || "https://github.com/JoshStremmel/Who2Root4"}
        target="_blank" rel="noreferrer">
          <code></code>
        </a>
        {" · "}{window.WEEK_META.season} season, {window.WEEK_META.label}
        {window.W2R4_SOURCE?.loadedAt &&
        <> {" · "} loaded {new Date(window.W2R4_SOURCE.loadedAt).toLocaleTimeString()}</>
        }
      </footer>

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection label="Display">
          <window.TweakRadio
            label="Theme"
            value={tw.theme}
            options={[
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" }]
            }
            onChange={(v) => setTweak("theme", v)} />
          
        </window.TweakSection>
        <window.TweakSection label="Your team">
          <window.TweakSelect
            label="Favorite team"
            value={tw.favTeam}
            options={Object.values(window.TEAMS).map((t) => ({
              label: `${t.city} ${t.name} (${t.abbr})`,
              value: t.abbr
            }))}
            onChange={(v) => setTweak("favTeam", v)} />
          
          <window.TweakSelect
            label="Goal"
            value={tw.mode || "overall"}
            options={window.MODES.map((m) => ({ label: m.label, value: m.id }))}
            onChange={(v) => setTweak("mode", v)} />
          
          <window.TweakButton label="Edit team & dislikes →" onClick={() => setOnboarding(true)} />
        </window.TweakSection>
        <window.TweakSection label="Session">
          <window.TweakButton label="Log out (reset prototype)" onClick={handleLogout} />
        </window.TweakSection>
      </window.TweaksPanel>
    </div>);

}

/* ─── Bootstrap gate ──────────────────────────────────────────────────────
 * The data layer (src/data.js) fetches scoreboard JSON from
 *   github.com/JoshStremmel/Who2Root4/.cache/espn/
 * Block app render until those globals are populated so every component below
 * can rely on window.TEAMS / window.SCHEDULE / window.WEEK_META synchronously.
 */
function W2R4Bootstrap() {
  const [status, setStatus] = useAppState(() => window.W2R4_LOAD_STATUS?.state || "loading");
  const [errMsg, setErrMsg] = useAppState(() =>
  window.W2R4_LOAD_STATUS?.error?.message || null);

  useAppEffect(() => {
    if (status === "ready") return;
    window.W2R4_LOAD_PROMISE.
    then(() => setStatus("ready")).
    catch((e) => {setErrMsg(e?.message || String(e));setStatus("error");});
  }, []);

  if (status === "loading") {
    return (
      <div className="w2r4-boot">
        <div className="w2r4-boot-card">
          <div className="w2r4-boot-logo">W4</div>
          <div className="w2r4-boot-title">Who2Root4</div>
          <div className="w2r4-boot-sub">Pulling live data from <code>github.com/JoshStremmel/Who2Root4</code>…</div>
          <div className="w2r4-boot-bar"><span /></div>
        </div>
      </div>);

  }

  if (status === "error") {
    return (
      <div className="w2r4-boot">
        <div className="w2r4-boot-card error">
          <div className="w2r4-boot-title">Couldn't load data</div>
          <div className="w2r4-boot-sub">{errMsg}</div>
          <div className="w2r4-boot-help">
            The app fetches <code>.cache/espn/scoreboard_*.json</code> from the repo.
            Make sure the repo is public and at least one weekly scoreboard JSON has been committed.
          </div>
          <button className="w2r4-boot-retry" onClick={() => location.reload()}>Retry</button>
        </div>
      </div>);

  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<W2R4Bootstrap />);