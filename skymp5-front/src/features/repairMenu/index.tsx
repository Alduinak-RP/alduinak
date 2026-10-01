import React, { useEffect, useState } from 'react';

import './styles.scss';

interface RepairEvents {
  repair: string;
  repairAll: string;
  improve: string;
  close: string;
  [key: string]: string;
}

// One material of a row; have is everything the player holds, not reduced by other rows
interface RepairCost {
  baseId: number;
  name: string;
  need: number;
  have: number;
}

// One damaged copy as the server's repairMenu packet lists it (durabilitySystem.ts)
export interface RepairRow {
  key: string | number; // the server's handle of the copy, sent back as it came
  baseId: number;
  name: string;
  percent: number; // 0 is broken
  hp: number;
  maxHp: number; // 0 when the server has no hit points for the copy
  worn: boolean;
  cost: RepairCost[];
}

// The widget object the client pushes through window.skyrimPlatform.widgets (repairService.ts)
export interface RepairMenuData {
  kind: string;
  title: string;
  rows: RepairRow[];
  events: RepairEvents;
}

// Below this percent the bar turns bright
const LOW_PERCENT = 25;

// A repair is answered with a refresh; "too far from the bench" is not, so the buttons come back on their own
const BUSY_MS = 1500;

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('repairMenu sendMessage', key, args);
  }
};

export const canAfford = (row: RepairRow): boolean => (row.cost || []).every((c) => c.have >= c.need);

// "43% (150/350)", the percent alone without hit points
export const conditionText = (row: RepairRow): string =>
  (row.percent > 0 ? row.percent + '%' : 'Broken') + (row.maxHp > 0 ? ` (${row.hp}/${row.maxHp})` : '');

const barWidth = (percent: number): string => Math.max(0, Math.min(100, percent || 0)) + '%';

const RepairMenu = ({ data }: { data: RepairMenuData }) => {
  const ev = data.events || ({} as RepairEvents);
  const rows = data.rows || [];
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
  }, [data.rows]);

  useEffect(() => {
    if (!busy) return undefined;
    const timer = setTimeout(() => setBusy(false), BUSY_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  const repair = (event: string, ...args: unknown[]): void => {
    setBusy(true);
    send(event, ...args);
  };

  return (
    <div className="repair-menu">
      <div className="repair-menu__fade" />
      <div className="repair-menu__panel">
        <div className="repair-menu__header">
          <h2 className="repair-menu__title">{data.title || 'Repair'}</h2>
          <span className="repair-menu__status">
            {rows.length === 0 ? 'All repaired' : rows.length + (rows.length === 1 ? ' damaged item' : ' damaged items')}
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="repair-menu__empty">Nothing left to repair</p>
        ) : (
          <div className="repair-menu__rows">
            {rows.map((row, n) => {
              const cost = row.cost || [];
              return (
                <div key={n + ':' + row.key} className="repair-menu__row">
                  <div className="repair-menu__info">
                    <span className="repair-menu__name">
                      {row.name}
                      {row.worn ? <span className="repair-menu__tag">equipped</span> : null}
                    </span>
                    <div className="repair-menu__condition">
                      <div className="repair-menu__bar">
                        <div
                          className={'repair-menu__bar-fill' + (row.percent < LOW_PERCENT ? ' repair-menu__bar-fill--low' : '')}
                          style={{ width: barWidth(row.percent) }}
                        />
                      </div>
                      <span className={'repair-menu__percent' + (row.percent > 0 ? '' : ' repair-menu__percent--broken')}>
                        {conditionText(row)}
                      </span>
                    </div>
                    <span className="repair-menu__cost">
                      {cost.length === 0
                        ? 'No materials needed'
                        : cost.map((c, i) => (
                            <span
                              key={i + ':' + c.baseId}
                              className={'repair-menu__material' + (c.have >= c.need ? '' : ' repair-menu__material--short')}
                            >
                              {c.need} {c.name} <span className="repair-menu__have">(have {c.have})</span>
                            </span>
                          ))}
                    </span>
                  </div>
                  <button
                    className="repair-menu__button repair-menu__button--primary"
                    disabled={busy || !canAfford(row)}
                    onClick={() => repair(ev.repair, row.key)}
                  >
                    Repair
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="repair-menu__footer">
          <button
            className="repair-menu__button repair-menu__button--primary"
            disabled={busy || !rows.some(canAfford)}
            onClick={() => repair(ev.repairAll)}
          >
            Repair all
          </button>
          <button className="repair-menu__button" onClick={() => send(ev.improve)}>
            Improve items
          </button>
          <button className="repair-menu__button repair-menu__button--quiet" onClick={() => send(ev.close)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default RepairMenu;
