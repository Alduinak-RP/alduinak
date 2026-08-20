/* eslint-disable react/prop-types */
import React from 'react';

import { findSpecies } from '../data/races';

const RaceScreen = ({ species, selected, disabledRaces, lockedRaces, onSelect }) => {
  const spec = findSpecies(species);
  if (!spec) return null;
  const races = spec.races.filter(r => !disabledRaces.includes(r.id));
  const current = races.find(r => r.id === selected);

  return (
    <div className='charCreator__screen'>
      <div className='charCreator__title'>Choose your race</div>
      <div className='charCreator__race-grid'>
        {races.map(race => {
          const isLocked = lockedRaces.includes(race.id);
          return (
            <div
              key={race.id}
              className={
                'charCreator__circle charCreator__circle--race' +
                (selected === race.id ? ' charCreator__circle--selected' : '') +
                (isLocked ? ' charCreator__circle--locked' : '')
              }
              onClick={isLocked ? undefined : () => onSelect(race.id)}
            >
              {race.name}
              {isLocked ? <span className='charCreator__lock-glyph'>&#128274;</span> : null}
            </div>
          );
        })}
      </div>
      {current
        ? (
          <div className='charCreator__lore'>
            <div className='charCreator__lore-title'>{current.name}</div>
            <div className='charCreator__lore-text'>{current.lore}</div>
            {current.placeholder
              ? <div className='charCreator__note'>This race uses a temporary look until its own model is ready.</div>
              : null}
          </div>
          )
        : <div className='charCreator__blurb'>Select a race to read about it.</div>}
    </div>
  );
};

export default RaceScreen;
