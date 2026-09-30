import React from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets; the survival fields are absent on older clients
export interface FatigueReadoutData {
  fatigue: number;
  stageName: string;
  coldStage?: number;
  coldStageName?: string;
  diseases?: Array<{ name: string; stage: number }>;
  afflictions?: string[];
}

// Chilly and colder, as the client opens the widget
const COLD_LINE_STAGE = 2;
const FREEZING_STAGE = 4;
// The plugin's stage spell names (survivalDiseases.ts STAGE_SUFFIX)
const DISEASE_STAGE_SUFFIX = ['', ' (advanced)', ' (severe)'];

export const diseaseStageName = (name: string, stage: number): string =>
  name + (DISEASE_STAGE_SUFFIX[Math.min(DISEASE_STAGE_SUFFIX.length, Math.max(1, Math.round(stage))) - 1] || '');

const FatigueReadout = ({ data }: { data: FatigueReadoutData }) => {
  const fatigue = typeof data.fatigue === 'number' && data.fatigue < 100 ? data.fatigue : null;
  const coldStage = typeof data.coldStage === 'number' ? data.coldStage : -1;
  const cold = coldStage >= COLD_LINE_STAGE && data.coldStageName ? data.coldStageName : '';
  const sick = (data.diseases || []).map((d) => diseaseStageName(d.name, d.stage)).concat(data.afflictions || []);
  if (fatigue === null && !cold && !sick.length) return null;
  return (
    <div className="fatigueReadout">
      {sick.length ? (
        <div className="fatigueReadout__line">
          <span className="fatigueReadout__label">Sick</span>
          <span className="fatigueReadout__sick">{sick.join(', ')}</span>
        </div>
      ) : null}
      {cold ? (
        <div className="fatigueReadout__line">
          <span className="fatigueReadout__label">Cold</span>
          <span className={'fatigueReadout__cold' + (coldStage >= FREEZING_STAGE ? ' fatigueReadout__cold--severe' : '')}>{cold}</span>
        </div>
      ) : null}
      {fatigue !== null ? (
        <div className="fatigueReadout__line">
          <span className="fatigueReadout__label">Fatigue</span>
          <span className="fatigueReadout__value">{fatigue}%</span>
          {data.stageName && <span className="fatigueReadout__stage">{data.stageName}</span>}
        </div>
      ) : null}
    </div>
  );
};

export default FatigueReadout;
