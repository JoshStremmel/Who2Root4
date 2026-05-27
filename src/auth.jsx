/* Auth screen — sign up / log in.
 * Fully client-side prototype: anything plausible (email + 6+ char password) is accepted;
 * persisted to localStorage under W2R4_USERS so a sign-up survives reload and can later log in.
 */

const { useState: useAuthState } = React;

const USERS_KEY = "w2r4_users_v1";
const SESSION_KEY = "w2r4_session_v1";

function loadUsers() {
  try {return JSON.parse(localStorage.getItem(USERS_KEY) || "{}");}
  catch (_) {return {};}
}
function saveUsers(u) {localStorage.setItem(USERS_KEY, JSON.stringify(u));}
function saveSession(s) {localStorage.setItem(SESSION_KEY, JSON.stringify(s));}
function loadSession() {
  try {return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");}
  catch (_) {return null;}
}
function clearSession() {localStorage.removeItem(SESSION_KEY);}

window.W2R4_Auth = {
  loadSession, saveSession, clearSession,
  loadUsers, saveUsers
};

function Field({ label, type = "text", value, onChange, placeholder, hint, error, autoFocus }) {
  return (
    <label className="auth-field">
      <span className="auth-field-label">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={"auth-input" + (error ? " err" : "")} />
      
      {error ?
      <span className="auth-hint err">{error}</span> :
      hint ? <span className="auth-hint">{hint}</span> : null}
    </label>);

}

function Auth({ onAuthed }) {
  const [mode, setMode] = useAuthState("signup"); // "signup" | "login"
  const [name, setName] = useAuthState("");
  const [email, setEmail] = useAuthState("");
  const [pw, setPw] = useAuthState("");
  const [errors, setErrors] = useAuthState({});
  const [busy, setBusy] = useAuthState(false);
  const [devOpen, setDevOpen] = useAuthState(false);
  const currentSimWeek = (() => {
    try { const n = Number(localStorage.getItem("w2r4_sim_week")); return n >= 1 && n <= 18 ? n : null; }
    catch { return null; }
  })();

  const switchMode = (m) => {setMode(m);setErrors({});};

  const submit = (e) => {
    e && e.preventDefault();
    const err = {};
    if (mode === "signup" && !name.trim()) err.name = "Tell us what to call you";
    if (!/^\S+@\S+\.\S+$/.test(email)) err.email = "That doesn't look like an email";
    if (pw.length < 6) err.pw = "At least 6 characters";

    if (Object.keys(err).length) {setErrors(err);return;}
    setBusy(true);

    // Simulate network round-trip so the button feels real
    setTimeout(() => {
      const users = loadUsers();
      const key = email.trim().toLowerCase();
      if (mode === "signup") {
        if (users[key]) {
          setErrors({ email: "An account already exists for this email. Try logging in." });
          setBusy(false);
          return;
        }
        users[key] = { email: key, name: name.trim(), pw, createdAt: Date.now(), onboarded: false };
        saveUsers(users);
        saveSession({ email: key, name: name.trim(), onboarded: false });
        setBusy(false);
        onAuthed({ email: key, name: name.trim(), onboarded: false });
      } else {
        const u = users[key];
        if (!u || u.pw !== pw) {
          setErrors({ pw: "Email or password doesn't match." });
          setBusy(false);
          return;
        }
        saveSession({ email: u.email, name: u.name, onboarded: !!u.onboarded });
        setBusy(false);
        onAuthed({ email: u.email, name: u.name, onboarded: !!u.onboarded });
      }
    }, 320);
  };

  const useGuest = () => {
    const session = { email: null, name: "Guest", onboarded: false, isGuest: true };
    saveSession(session);
    onAuthed(session);
  };

  const pickSimWeek = (week) => {
    if (week == null) localStorage.removeItem("w2r4_sim_week");
    else              localStorage.setItem("w2r4_sim_week", String(week));
    location.reload();
  };

  const isSignup = mode === "signup";

  return (
    <div className="auth-shell">
      <div className="auth-side">
        <div className="auth-brand">
          <span className="brand-word">Who2Root4<sup className="w2r4-tm">TM</sup></span>
        </div>
        <div className="auth-pitch">
          <div className="onb-eyebrow">FOR FANS OF ANY TEAM</div>
          <h1 className="auth-pitch-title">
            Every week,<br />a reason to care<br />about every game.
          </h1>
          <p className="auth-pitch-sub">Pick your favorite team and see which games to watch — ranked by playoff implications.


          </p>
          <ul className="auth-bullets">
            <li><span className="dot"></span> Ranked rooting recommendations, every week</li>
            <li><span className="dot"></span> Division &amp; conference impact, scored</li>
            <li><span className="dot"></span> A schedule that knows what you care about</li>
          </ul>
        </div>
        <div className="auth-foot mono">POWERED BY AI & ANALYTICS</div>
      </div>

      <div className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={isSignup}
            className={"auth-tab" + (isSignup ? " active" : "")}
            onClick={() => switchMode("signup")}>
              Sign up
            </button>
            <button type="button" role="tab" aria-selected={!isSignup}
            className={"auth-tab" + (!isSignup ? " active" : "")}
            onClick={() => switchMode("login")}>
              Log in
            </button>
            <div className="auth-tab-thumb" style={{ left: isSignup ? "4px" : "calc(50% + 0px)" }}></div>
          </div>

          <h2 className="auth-form-title">
            {isSignup ? "Create your account" : "Welcome back"}
          </h2>
          <p className="auth-form-sub">
            {isSignup ?
            "Save your preferences" :
            "Pick up where you left off."}
          </p>

          {isSignup &&
          <Field label="Name" value={name} onChange={setName}
          placeholder="Your name" error={errors.name} autoFocus />
          }
          <Field label="Email" type="email" value={email} onChange={setEmail}
          placeholder="you@example.com" error={errors.email}
          autoFocus={!isSignup} />
          <Field label="Password" type="password" value={pw} onChange={setPw}
          placeholder={isSignup ? "At least 6 characters" : "Your password"}
          error={errors.pw}
          hint={isSignup ? "Stored locally on this device for the prototype." : null} />

          <button type="submit" className="btn primary auth-submit" disabled={busy}>
            {busy ?
            isSignup ? "Creating account…" : "Logging in…" :
            isSignup ? "Create account" : "Log in"}
            <span style={{ fontSize: 11, opacity: 0.9 }}>→</span>
          </button>

          <div className="auth-divider"><span>or</span></div>

          <button type="button" className="btn ghost auth-demo" onClick={useGuest}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ marginRight: 2 }}>
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
            Continue as guest
          </button>

          <p className="auth-fineprint">
            Guests pick a team and use everything — sign up later to save it across devices.
          </p>

          {/* Dev mode toggle — simulates `pipeline.py --full-season --sim-week N` */}
          <div className="auth-dev">
            <button type="button" className="auth-dev-btn" onClick={() => setDevOpen(!devOpen)}>
              <span className="auth-dev-dot" data-on={currentSimWeek ? "true" : "false"}></span>
              Dev: simulate week
              {currentSimWeek && <span className="auth-dev-pill">Week {currentSimWeek}</span>}
              <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: 11 }}>{devOpen ? "▴" : "▾"}</span>
            </button>
            {devOpen && (
              <div className="auth-dev-panel">
                <div className="auth-dev-help">
                  Pretend it's the start of this week of the 2025 season. Games at this week and beyond are treated as unplayed (mirrors <code>--sim-week</code> on the pipeline).
                </div>
                <div className="auth-dev-grid">
                  {Array.from({ length: 18 }, (_, i) => i + 1).map(w => (
                    <button key={w} type="button"
                            className={"auth-dev-week" + (currentSimWeek === w ? " active" : "")}
                            onClick={() => pickSimWeek(w)}>
                      {w}
                    </button>
                  ))}
                </div>
                <button type="button" className="auth-dev-clear" onClick={() => pickSimWeek(null)} disabled={!currentSimWeek}>
                  Clear dev mode (use live data)
                </button>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>);

}

window.Auth = Auth;