import React from 'react';

import './styles.scss';
import { loc } from '../../loc';

// The widget object the client pushes through window.skyrimPlatform.widgets
export interface SurvivalReadoutData {
  coldStage?: number;
  coldStageName?: string;
  warmth?: number;
}

// Chilly and colder, as the client opens the widget
const COLD_LINE_STAGE = 2;
const FREEZING_STAGE = 4;
// The plugin's stage spell names (survivalDiseases.ts STAGE_SUFFIX)
const DISEASE_STAGE_SUFFIX = ['', ' (advanced)', ' (severe)'];

// For the admin panel's survival row; the HUD shows no sickness, Active Effects lists it
export const diseaseStageName = (name: string, stage: number): string =>
  name + (DISEASE_STAGE_SUFFIX[Math.min(DISEASE_STAGE_SUFFIX.length, Math.max(1, Math.round(stage))) - 1] || '');

const SurvivalReadout = ({ data }: { data: SurvivalReadoutData }) => {
  const coldStage = typeof data.coldStage === 'number' ? data.coldStage : -1;
  const cold = coldStage >= COLD_LINE_STAGE && data.coldStageName ? data.coldStageName : '';
  if (!cold) return null;
  // The server's total: the inventory's Warmth leaves out cloaks, scarves and the pieces armorWarmth.ts rates
  const warmth = typeof data.warmth === 'number' && data.warmth >= 0 ? Math.round(data.warmth) : null;
  return (
    <div className="survivalReadout">
      <div className="survivalReadout__line">
        <span className="survivalReadout__label">{loc('survival.cold')}</span>
        <span className={'survivalReadout__cold' + (coldStage >= FREEZING_STAGE ? ' survivalReadout__cold--severe' : '')}>{cold}</span>
        {warmth !== null && <span className="survivalReadout__warmth">{loc('survival.warmth', { n: warmth })}</span>}
      </div>
    </div>
  );
};

export default SurvivalReadout;
