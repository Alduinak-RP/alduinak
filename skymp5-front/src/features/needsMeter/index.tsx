import React from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface NeedsMeterData {
  // 100 = full stomach
  hunger: number;
  stage: number;
  stageName: string;
  // 100 = rested
  fatigue: number;
}

const clamp = (v: number): number => Math.max(0, Math.min(100, Number(v) || 0));

const NeedsMeter = ({ data }: { data: NeedsMeterData }) => {
  const hunger = clamp(data.hunger);
  const fatigue = clamp(data.fatigue);
  return (
    <div className="needsMeter">
      <div className="needsMeter__row">
        <span className="needsMeter__label">{data.stageName || 'Hunger'}</span>
        <div className={`needsMeter__bar needsMeter__bar--hunger needsMeter__bar--stage${data.stage}`}>
          <div className="needsMeter__fill" style={{ width: `${hunger}%` }} />
        </div>
      </div>
      <div className="needsMeter__row">
        <span className="needsMeter__label">Fatigue {Math.round(fatigue)}%</span>
        <div className="needsMeter__bar needsMeter__bar--fatigue">
          <div className="needsMeter__fill" style={{ width: `${fatigue}%` }} />
        </div>
      </div>
    </div>
  );
};

export default NeedsMeter;
