import React, { useState, useEffect } from 'react';
import './styles.scss';

// Bespoke death screen. Driven by a `death` widget set from the client:
//   { type: 'death', seconds: <countdown>, onChoice: (key) => void }
// The body copy and the per-choice confirm text live here (static UI), the
// countdown is driven by `seconds`, and a confirmed choice calls onChoice with
// one of: 'permadeath' | 'resurrect' | 'temple'.

const CHOICES = [
  {
    key: 'permadeath',
    label: 'Permanent Death',
    confirm:
      'Warning: this will kill your character and make them unplayable. ' +
      'Everything will be lootable and your body will remain.',
  },
  {
    key: 'resurrect',
    label: 'Resurrect Here',
    confirm:
      'This will release you at full health where you are standing. This is to ' +
      'be used in the event of a glitch — abuse will result in a ban. All uses ' +
      'are logged, and if you die again to the same player you will be force ' +
      'permanently killed.',
  },
  {
    key: 'temple',
    label: 'Temple w/ Full Health',
    confirm:
      'This will send you to the nearest temple normally, except with full ' +
      'health, skipping the recovery system. This is an optional choice ' +
      'available to all players, with the catch that you cannot return to ' +
      'where you died for one hour.',
  },
];

const DeathScreen = (props) => {
  const initial = Number.isFinite(props.seconds) ? Math.max(0, Math.floor(props.seconds)) : 60;
  const [remaining, setRemaining] = useState(initial);
  const [pending, setPending] = useState(null); // a CHOICES entry awaiting confirm

  // Live countdown.
  useEffect(() => {
    setRemaining(initial);
    const id = setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [initial]);

  const choose = (key) => {
    if (typeof props.onChoice === 'function') props.onChoice(key);
  };

  return (
    <div className="death-screen">
      <div className="death-screen__panel">
        <h1 className="death-screen__title">You have died!</h1>

        {!pending && (
          <>
            <p className="death-screen__lead">
              You will automatically respawn at the nearest temple in{' '}
              <span className="death-screen__count">{remaining}</span> seconds.
            </p>
            <p className="death-screen__body">
              If you do nothing, normal respawn rules apply. You were found near
              death and brought to a temple by a traveler. You only remember
              vague details about your death, not enough to identify your killer
              if there was one.
            </p>
            <p className="death-screen__body">
              You will have 1 HP and naturally heal 1 point every 8 hours (even
              while logged off). A healer can accelerate this to 5 HP every 8
              hours.
            </p>
            <p className="death-screen__hint">
              Optionally, you can choose one of the following:
            </p>
            <div className="death-screen__choices">
              {CHOICES.map((c) => (
                <button
                  key={c.key}
                  className={'death-screen__btn death-screen__btn--' + c.key}
                  onClick={() => setPending(c)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </>
        )}

        {pending && (
          <div className="death-screen__confirm">
            <h2 className="death-screen__confirm-title">{pending.label}</h2>
            <p className="death-screen__confirm-text">{pending.confirm}</p>
            <div className="death-screen__confirm-actions">
              <button
                className="death-screen__btn death-screen__btn--danger"
                onClick={() => choose(pending.key)}
              >
                Confirm
              </button>
              <button
                className="death-screen__btn death-screen__btn--cancel"
                onClick={() => setPending(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DeathScreen;
