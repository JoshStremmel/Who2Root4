/* Onboarding flow: pick favorite team, then optional dislikes. */

const { useState, useEffect } = React;

function TeamPickerStep({ step, fav, setFav, dislikes, toggleDislike, onNext, onSkipDislikes, onBack }) {
  const isStep1 = step === 1;

  useEffect(() => {
    // When advancing/returning between steps, snap back to the top so the
    // user sees the new heading instead of landing mid-grid.
    window.scrollTo({ top: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const shell = document.querySelector(".onb-shell");
    if (shell) shell.scrollTop = 0;
  }, [step]);
  const sortedDivisions = [
  "AFC North", "AFC South", "AFC East", "AFC West",
  "NFC North", "NFC South", "NFC East", "NFC West"];


  const handleClick = (abbr) => {
    if (isStep1) {
      setFav(abbr);
    } else {
      if (!fav) return;
      const favDivision = window.TEAMS[fav]?.div;
      const favConference = window.TEAMS[fav]?.conf;
      const inSameDiv = window.TEAMS[abbr]?.div === favDivision && window.TEAMS[abbr]?.conf === favConference;
      if (abbr === fav || inSameDiv) return; // cannot dislike own team or division
      toggleDislike(abbr);
    }
  };

  return (
    <div className="onb-shell">
      <div className="onb-inner">
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 20, letterSpacing: "-0.01em", marginBottom: 14, color: "var(--text)" }}>
          Who2Root4<sup className="w2r4-tm">TM</sup>
        </div>
        <h1 className="onb-title">
          {isStep1 ?
          "Who's your team?" :
          "Choose your rivals"}
        </h1>
        <p className="onb-sub">
          {isStep1 ?
          "We'll use this to figure out which other games actually matter to you each week — divisional rivals, conference threats, must-watch scenarios." :
          "Optional. Choose teams you like to see lose. You can change this anytime."}
        </p>

        <div className="onb-steps">
          <span className={"crumb" + (isStep1 ? " active" : "")}>01 — Team</span>
          <span className="sep">›</span>
          <span className={"crumb" + (!isStep1 ? " active" : "")}>02 — RIVALS</span>
          <span className="sep">›</span>
          <span className="crumb">03 — RESULTS</span>
        </div>

        {sortedDivisions.map((div, divIdx) => {
          const [conf, divName] = div.split(" ");
          const rawAbbrs = window.TEAMS_BY_DIVISION[`${conf} ${divName}`] || [];
          const abbrs = rawAbbrs.slice().sort((a, b) => {
            const ta = window.TEAMS[a], tb = window.TEAMS[b];
            const aP = ta.record[0] / Math.max(1, ta.record[0] + ta.record[1]);
            const bP = tb.record[0] / Math.max(1, tb.record[0] + tb.record[1]);
            return bP - aP || tb.record[0] - ta.record[0];
          });
          const favDiv = fav ? window.TEAMS[fav]?.div : null;
          const favConf = fav ? window.TEAMS[fav]?.conf : null;
          return (
            <div className="div-section" key={div}>
              <h4>{conf} {divName}</h4>
              <div className="team-grid">
                {abbrs.map((abbr, i) => {
                  const t = window.TEAMS[abbr];
                  const selected = isStep1 ? fav === abbr : dislikes.has(abbr);
                  const isOwn = !isStep1 && abbr === fav;
                  const isDivTeam = !isStep1 && !isOwn && t.div === favDiv && t.conf === favConf;
                  const isGrayedOut = isOwn || isDivTeam;
                  const tileStyle = { "--enter-delay": `${divIdx * 60 + i * 25}ms` };
                  return (
                    <button
                      key={abbr}
                      className={"team-tile" + (selected ? isStep1 ? " selected" : " disliked" : "")}
                      onClick={() => handleClick(abbr)}
                      disabled={isGrayedOut}
                      style={tileStyle}>
                      
                      <div className="swatch" style={{ background: t.color }}></div>
                      <div>
                        <div className="name">{t.name}</div>
                        <div className="abbr">{t.abbr} · {t.record[0]}-{t.record[1]}</div>
                      </div>
                      {selected &&
                      <div className="check" style={!isStep1 ? { background: "var(--warn)" } : null}>
                          {isStep1 ? "✓" : "✕"}
                        </div>
                      }
                    </button>);

                })}
              </div>
            </div>);

        })}

        <div className="onb-actions">
          <span className="helper">
            {isStep1 ?
            fav ? `${window.TEAMS[fav].city} ${window.TEAMS[fav].name}` : "Pick one to continue" :
            `${dislikes.size} team${dislikes.size === 1 ? "" : "s"} you like to root against`}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {!isStep1 &&
            <button className="btn ghost" onClick={onBack}>Back</button>
            }
            {!isStep1 &&
            <button className="btn ghost" onClick={onSkipDislikes}>Skip</button>
            }
            <button className="btn primary" onClick={onNext} disabled={isStep1 && !fav}>
              {isStep1 ? "Continue" : "Results"}
              <span style={{ fontSize: 11, opacity: 0.9 }}>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>);

}

function Onboarding({ onFinish }) {
  const [step, setStep] = useState(1);
  const [fav, setFav] = useState(null);
  const [dislikes, setDislikes] = useState(new Set());

  const toggleDislike = (abbr) => {
    setDislikes((prev) => {
      const next = new Set(prev);
      if (next.has(abbr)) next.delete(abbr);else next.add(abbr);
      return next;
    });
  };

  return (
    <TeamPickerStep
      step={step}
      fav={fav}
      setFav={setFav}
      dislikes={dislikes}
      toggleDislike={toggleDislike}
      onBack={() => setStep(1)}
      onSkipDislikes={() => onFinish(fav, [])}
      onNext={() => {
        if (step === 1) setStep(2);else
        onFinish(fav, Array.from(dislikes));
      }} />);


}

window.Onboarding = Onboarding;