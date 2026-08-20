/* eslint-disable react/prop-types */
import React, { useState } from 'react';

import { SPECIES } from '../data/races';

const SpeciesScreen = ({ selected, onSelect }) => {
  const [hovered, setHovered] = useState(null);
  const shown = SPECIES.find(s => s.id === (hovered || selected));

  return (
    <div className='charCreator__screen'>
      <div className='charCreator__title'>Choose your species</div>
      <div className='charCreator__species-grid'>
        {SPECIES.map(species => (
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
