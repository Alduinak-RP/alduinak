import React, { useState } from 'react';

import Button from '../../constructorComponents/button';
import { loc } from '../../loc';
import Dropdown, { DropdownOption } from './dropdown';
import { FactionMenuData, TYPE_LABEL } from './factionTab';

interface FactionAssignProps {
  faction: FactionMenuData | null | undefined;
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
  target: string | undefined; // the selected character's actor id hex, online only
  enabled: boolean;
}

const byLabel = (a: DropdownOption, b: DropdownOption): number => a.label.localeCompare(b.label);

const distinct = (values: string[]): string[] => values.filter((v, i) => values.indexOf(v) === i);

// Players tab faction box: province, type and faction narrow each other; positions keep the ladder order
const FactionAssign = ({ faction, ev, send, target, enabled }: FactionAssignProps) => {
  const [province, setProvince] = useState('');
  const [type, setType] = useState('');
  const [rank, setRank] = useState('');

  const factions = faction?.factions || [];
  const detail = faction?.detail || null;

  const provinces = distinct(factions.map((f) => f.province)).map((p) => ({ value: p, label: p })).sort(byLabel);
  const pickedProvince = provinces.some((o) => o.value === province) ? province : detail?.province || '';
  const inProvince = factions.filter((f) => f.province === pickedProvince);
  const types = distinct(inProvince.map((f) => f.type)).map((t) => ({ value: t, label: TYPE_LABEL[t] || t })).sort(byLabel);
  const pickedType = types.some((o) => o.value === type) ? type : detail && detail.province === pickedProvince ? detail.type : '';
  const shown = inProvince.filter((f) => f.type === pickedType).map((f) => ({ value: f.id, label: f.name })).sort(byLabel);
  const pickedFaction = detail && shown.some((o) => o.value === detail.id) ? detail.id : '';
  const ranks = pickedFaction && detail ? detail.ranks : [];
  const pickedRank = ranks.some((r) => r.slug === rank) ? rank : ranks[ranks.length - 1]?.slug || '';

  const act = (action: 'adminAdd' | 'adminRemove'): void => {
    if (!target || !pickedFaction) return;
    send(ev.faction, JSON.stringify({ action, factionId: pickedFaction, rank: action === 'adminAdd' ? pickedRank : undefined, target: parseInt(target, 16) }));
  };

  return (
    <div className="admin-panel__mastery">
      <div className="admin-panel__mastery-row">
        <span className="admin-panel__mastery-who">{loc('adminPanel.factionAssign.faction')}</span>
        <Dropdown
          className="admin-panel__faction-pick admin-panel__faction-pick--short"
          value={pickedProvince}
          placeholder={factions.length ? loc('adminPanel.factionAssign.province') : loc('adminPanel.faction.loading')}
          disabled={!factions.length}
          options={provinces}
          onChange={(p) => {
            setProvince(p);
            setType('');
          }}
        />
        <Dropdown
          className="admin-panel__faction-pick admin-panel__faction-pick--short"
          value={pickedType}
          placeholder={loc('adminPanel.common.type')}
          disabled={!pickedProvince}
          options={types}
          onChange={setType}
        />
        <Dropdown
          className="admin-panel__faction-pick admin-panel__faction-pick--wide"
          value={pickedFaction}
          placeholder={loc('adminPanel.factionAssign.faction')}
          disabled={!pickedType}
          options={shown}
          onChange={(id) => ev.factionMenu && send(ev.factionMenu, id)}
        />
        <Dropdown
          className="admin-panel__faction-pick admin-panel__faction-pick--rank"
          value={pickedRank}
          placeholder={loc('adminPanel.factionAssign.position')}
          disabled={!pickedFaction}
          options={ranks.map((r) => ({ value: r.slug, label: r.name }))}
          onChange={setRank}
        />
        <Button text={loc('adminPanel.common.add')} width={72} height={30} disabled={!enabled || !pickedFaction || !pickedRank} onClick={() => act('adminAdd')} />
        <Button text={loc('adminPanel.common.remove')} width={88} height={30} disabled={!enabled || !pickedFaction} onClick={() => act('adminRemove')} />
      </div>
      <span className="admin-panel__hint">{loc('adminPanel.factionAssign.hint')}</span>
    </div>
  );
};

export default FactionAssign;
