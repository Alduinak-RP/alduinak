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
  fatigueStageName?: string;
  // 0-1 share of the maximum removed
  staminaPenalty?: number;
  magickaPenalty?: number;
}

const clamp = (v: number): number => Math.max(0, Math.min(100, Number(v) || 0));

const penaltyText = (attribute: string, share?: number): string | null => {
  const percent = Math.round((Number(share) || 0) * 100);
  return percent > 0 ? `${attribute} -${percent}%` : null;
};

const NeedsMeter = ({ data }: { data: NeedsMeterData }) => {
  const hunger = clamp(data.hunger);
  const fatigue = clamp(data.fatigue);
  const stamina = penaltyText('Max stamina', data.staminaPenalty);
  const magicka = penaltyText('Max magicka', data.magickaPenalty);
  return (
    <div className="needsMeter">
      <div className="needsMeter__row">
        <span className="needsMeter__label">
          {data.stageName || 'Hunger'}
          {stamina && <span className="needsMeter__penalty">{stamina}</span>}
        </span>
        <div className={`needsMeter__bar needsMeter__bar--hunger needsMeter__bar--stage${data.stage}`}>
          <div className="needsMeter__fill" style={{ width: `${hunger}%` }} />
        </div>
      </div>
      <div className="needsMeter__row">
        <span className="needsMeter__label">
          {data.fatigueStageName || 'Fatigue'} {Math.round(fatigue)}%
          {magicka && <span className="needsMeter__penalty">{magicka}</span>}
        </span>
        <div className="needsMeter__bar needsMeter__bar--fatigue">
          <div className="needsMeter__fill" style={{ width: `${fatigue}%` }} />
        </div>
      </div>
    </div>
  );
};

export default NeedsMeter;
