import React from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface FatigueReadoutData {
  fatigue: number;
  stageName: string;
}

const FatigueReadout = ({ data }: { data: FatigueReadoutData }) => {
  if (typeof data.fatigue !== 'number' || data.fatigue >= 100) return null;
  return (
    <div className="fatigueReadout">
      <span className="fatigueReadout__label">Fatigue</span>
      <span className="fatigueReadout__value">{data.fatigue}%</span>
      {data.stageName && <span className="fatigueReadout__stage">{data.stageName}</span>}
    </div>
  );
};

export default FatigueReadout;
