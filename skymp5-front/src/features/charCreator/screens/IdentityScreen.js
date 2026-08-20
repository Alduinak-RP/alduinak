/* eslint-disable react/prop-types */
import React, { useRef, useEffect } from 'react';

import { AGES } from '../data/races';
import { ATTRIBUTES, STAT_MIN, STAT_MAX, pointsSpent } from '../data/stats';

// A -/+ button that repeats while held down; kept enabled so mouseup always fires.
const Stepper = ({ label, disabled, onStep }) => {
  const timers = useRef({});
  const stop = () => {
    clearTimeout(timers.current.delay);
    clearInterval(timers.current.repeat);
  };
  useEffect(() => stop, []);
  const start = () => {
    if (disabled) return;
    onStep();
    timers.current.delay = setTimeout(() => {
      timers.current.repeat = setInterval(onStep, 60);
    }, 350);
  };
  return (
    <button
      className={'charCreator__stepper' + (disabled ? ' charCreator__stepper--disabled' : '')}
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={stop}
    >
      {label}
    </button>
  );
};

const IdentityScreen = ({ sex, age, stats, statPool, allowChildren, onSex, onAge, onStats }) => {
  const spent = pointsSpent(stats);
  const remaining = statPool - spent;
  const ages = AGES.filter(a => allowChildren || a.id !== 'child');

  // Functional update so hold-to-repeat never works from a stale snapshot.
  const step = (id, dir) => {
    onStats(prev => {
      const value = prev[id] + dir;
      if (value < STAT_MIN || value > STAT_MAX) return prev;
      if (dir > 0 && pointsSpent(prev) >= statPool) return prev;
      return { ...prev, [id]: value };
    });
  };

  return (
    <div className='charCreator__screen'>
      <div className='charCreator__title'>Who are you?</div>
      <div className='charCreator__section-label'>Sex</div>
      <div className='charCreator__sex-row'>
        {['male', 'female'].map(s => (
          <div
            key={s}
            className={
              'charCreator__circle charCreator__circle--sex' +
              (sex === s ? ' charCreator__circle--selected' : '')
            }
            onClick={() => onSex(s)}
          >
            {s === 'male' ? 'Male' : 'Female'}
          </div>
        ))}
      </div>
      <div className='charCreator__section-label'>Age</div>
      <div className='charCreator__age-row'>
        {ages.map(a => (
          <div
            key={a.id}
            className={'charCreator__pill' + (age === a.id ? ' charCreator__pill--selected' : '')}
            onClick={() => onAge(a.id)}
          >
            {a.name}
          </div>
        ))}
      </div>
      <div className='charCreator__section-label'>
        Attributes
        <span className={'charCreator__points' + (remaining === 0 ? ' charCreator__points--spent' : '')}>
          {remaining} points left
        </span>
      </div>
      <div className='charCreator__stats'>
        {ATTRIBUTES.map(attr => {
          const value = stats[attr.id];
          return (
            <div key={attr.id} className='charCreator__stat-row' title={attr.desc}>
              <span className='charCreator__stat-name'>{attr.name}</span>
              <Stepper
                label='-'
                disabled={value <= STAT_MIN}
                onStep={() => step(attr.id, -1)}
              />
              <div className='charCreator__stat-bar'>
                <div className='charCreator__stat-bar-fill' style={{ width: `${value}%` }} />
              </div>
              <Stepper
                label='+'
                disabled={value >= STAT_MAX || remaining <= 0}
                onStep={() => step(attr.id, 1)}
              />
              <span className='charCreator__stat-value'>{value}</span>
            </div>
          );
        })}
      </div>
      <div className='charCreator__note'>Strength and Endurance set the limits of your body build.</div>
    </div>
  );
};

export default IdentityScreen;
