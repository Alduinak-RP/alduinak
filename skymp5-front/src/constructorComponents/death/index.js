import React, { useState, useEffect } from 'react';
import './styles.scss';
import { loc } from '../../loc';

// Death screen widget contract: { type: 'death', seconds: <countdown>, onChoice: (key) => void }
// where a confirmed choice calls onChoice with 'permadeath' | 'resurrect' | 'temple'.

const CHOICES = [
  {
    key: 'permadeath',
    label: loc('death.choice.permadeath'),
    confirm: loc('death.choice.permadeathConfirm'),
  },
  {
    key: 'resurrect',
    label: loc('death.choice.resurrect'),
    confirm: loc('death.choice.resurrectConfirm'),
  },
  {
    key: 'temple',
    label: loc('death.choice.temple'),
    confirm: loc('death.choice.templeConfirm'),
  },
];

const DeathScreen = (props) => {
  const initial = Number.isFinite(props.seconds) ? Math.max(0, Math.floor(props.seconds)) : 60;
  const [remaining, setRemaining] = useState(initial);
  const [pending, setPending] = useState(null); // a CHOICES entry awaiting confirm

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
        <h1 className="death-screen__title">{loc('death.title')}</h1>

        {!pending && (
          <>
            <p className="death-screen__lead">
              {loc('death.respawnBefore')}{' '}
              <span className="death-screen__count">{remaining}</span> {loc('death.respawnAfter')}
            </p>
            <p className="death-screen__body">
              {loc('death.body1')}
            </p>
            <p className="death-screen__body">
              {loc('death.body2')}
            </p>
            <p className="death-screen__hint">
              {loc('death.hint')}
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
                {loc('common.confirm')}
              </button>
              <button
                className="death-screen__btn death-screen__btn--cancel"
                onClick={() => setPending(null)}
              >
                {loc('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DeathScreen;
