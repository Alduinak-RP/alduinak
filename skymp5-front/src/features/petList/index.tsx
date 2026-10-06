import React, { useEffect } from 'react';

import './styles.scss';
import { loc } from '../../loc';

interface PetListEvents {
  summon: string;
  close: string;
  [key: string]: string;
}

// One stored pet as the server's petList packet lists it (petSystem.ts onList).
interface PetRow {
  uid: string;
  name: string;
  kind: string;
  homeName: string;
  out: boolean;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface PetListData {
  category: string;
  pets: PetRow[];
  events: PetListEvents;
}

const PLACE_LABEL: Record<string, string> = {
  stable: loc('petList.place.stable'),
  farm: loc('petList.place.farm'),
  house: loc('petList.place.house'),
};
const KIND_LABEL: Record<string, string> = {
  horse: loc('petList.kind.horse'),
  livestock: loc('petList.kind.livestock'),
  dog: loc('petList.kind.dog'),
};

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('petList sendMessage', key, args);
  }
};

const PetList = ({ data }: { data: PetListData }) => {
  const ev = data.events || ({} as PetListEvents);
  const pets = data.pets || [];
  const place = PLACE_LABEL[data.category] || loc('petList.place.other');

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  return (
    <div className="pet-list">
      <div className="pet-list__fade" />
      <div className="pet-list__panel">
        <div className="pet-list__header">
          <h2 className="pet-list__title">{loc('petList.title', { place })}</h2>
          <span className="pet-list__status">{pets.length === 1 ? loc('petList.countOne', { n: pets.length }) : loc('petList.countMany', { n: pets.length })}</span>
        </div>

        {pets.length === 0 ? (
          <p className="pet-list__empty">{loc('petList.empty')}</p>
        ) : (
          <div className="pet-list__rows">
            {pets.map((p) => (
              <div key={p.uid} className={'pet-list__row' + (p.out ? ' pet-list__row--out' : '')}>
                <div className="pet-list__info">
                  <span className="pet-list__name">{p.name}</span>
                  <span className="pet-list__kind">
                    {KIND_LABEL[p.kind] || p.kind}
                    {p.homeName ? ' · ' + p.homeName : ''}
                  </span>
                </div>
                <button
                  className="pet-list__button pet-list__button--primary"
                  disabled={p.out}
                  onClick={() => send(ev.summon, p.uid)}
                >
                  {p.out ? loc('petList.out') : loc('petList.summon')}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="pet-list__footer">
          <button className="pet-list__button pet-list__button--quiet" onClick={() => send(ev.close)}>
            {loc('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PetList;
