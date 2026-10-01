import React from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets
export interface SurvivalReadoutData {
  coldStage?: number;
  coldStageName?: string;
  warmth?: number;
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

const SurvivalReadout = ({ data }: { data: SurvivalReadoutData }) => {
  const coldStage = typeof data.coldStage === 'number' ? data.coldStage : -1;
  const cold = coldStage >= COLD_LINE_STAGE && data.coldStageName ? data.coldStageName : '';
  // The server's total: the inventory's Warmth leaves out cloaks, scarves and the pieces armorWarmth.ts rates
  const warmth = typeof data.warmth === 'number' && data.warmth >= 0 ? Math.round(data.warmth) : null;
  const sick = (data.diseases || []).map((d) => diseaseStageName(d.name, d.stage)).concat(data.afflictions || []);
  if (!cold && !sick.length) return null;
  return (
    <div className="survivalReadout">
      {sick.length ? (
        <div className="survivalReadout__line">
          <span className="survivalReadout__label">Sick</span>
          <span className="survivalReadout__sick">{sick.join(', ')}</span>
        </div>
      ) : null}
      {cold ? (
        <div className="survivalReadout__line">
          <span className="survivalReadout__label">Cold</span>
          <span className={'survivalReadout__cold' + (coldStage >= FREEZING_STAGE ? ' survivalReadout__cold--severe' : '')}>{cold}</span>
          {warmth !== null && <span className="survivalReadout__warmth">warmth {warmth}</span>}
        </div>
      ) : null}
    </div>
  );
};

export default SurvivalReadout;
