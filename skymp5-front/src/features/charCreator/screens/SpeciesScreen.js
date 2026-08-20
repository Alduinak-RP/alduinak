/* eslint-disable react/prop-types */
import React, { useState } from 'react';

import { SPECIES } from '../data/races';

const SpeciesScreen = ({ selected, disabledRaces, onSelect }) => {
  const [hovered, setHovered] = useState(null);
  // A species with every race disabled would dead-end the wizard at step 2.
  const visible = SPECIES.filter(s => !s.races.every(r => (disabledRaces || []).includes(r.id)));
  const shown = visible.find(s => s.id === (hovered || selected));

  return (
    <div className='charCreator__screen'>
      <div className='charCreator__title'>Choose your species</div>
      <div className='charCreator__species-grid'>
        {visible.map(species => (
          <div
            key={species.id}
            className={
              'charCreator__circle charCreator__circle--species' +
              (selected === species.id ? ' charCreator__circle--selected' : '')
            }
            onClick={() => onSelect(species.id)}
            onMouseEnter={() => setHovered(species.id)}
            onMouseLeave={() => setHovered(null)}
          >
            {species.name}
          </div>
        ))}
      </div>
      <div className='charCreator__blurb'>
        {shown ? shown.blurb : 'Hover a species to learn more.'}
      </div>
    </div>
  );
};

export default SpeciesScreen;
