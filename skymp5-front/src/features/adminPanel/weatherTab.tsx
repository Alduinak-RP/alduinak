import React, { useState } from 'react';

import Button from '../../constructorComponents/button';
import Dropdown from './dropdown';
import { formatCountdown, isNum } from './util';

export interface WeatherChance {
  desc: string;
  edid: string;
  chance: number;
}

// One region as listed by the server (weatherSystem.ts WeatherRegionRow)
export interface WeatherRegionRow {
  id: string;
  name: string;
  weather: string; // editor id of the current weather
  weatherDesc: string;
  endsAt: number; // server epoch ms, 0 while forced until cleared
  forced: boolean;
  players: number;
  here: boolean; // the region the admin stands in
  weathers: WeatherChance[]; // the region's own list
}

export interface WeatherCatalogRow {
  desc: string;
  edid: string;
  kind: string;
}

// The adminWeather reply; at is the server clock it was built at, receivedAt the client clock (adminMenuService.ts)
export interface WeatherMenuData {
  regions: WeatherRegionRow[];
  weathers: WeatherCatalogRow[];
  at: number;
  receivedAt: number;
}

interface WeatherTabProps {
  data: WeatherMenuData | null;
  now: number;
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
}

// Same bound the server enforces for a timed force
const MAX_MINUTES = 1440;

// Region suffixes of the vanilla weather editor ids
const SUFFIXES: Record<string, string> = {
  TU: 'tundra', FF: 'fall forest', PI: 'pine forest', RE: 'reach', SN: 'snow', MA: 'marsh', CO: 'coast', VT: 'volcanic tundra', FV: 'forgotten vale',
};

// Closing the menu remounts the panel, so the form lives here
let savedForm = { region: '', weather: '', minutes: '' };

const isMinutes = (text: string): boolean =>
  text.trim() === '' || (isNum(text) && Number.isInteger(Number(text)) && Number(text) >= 1 && Number(text) <= MAX_MINUTES);

// SkyrimOvercastRainTU -> "Overcast Rain (tundra)", SkyrimClearSN_A -> "Clear (snow, aurora)"; unknown shapes keep their editor id
export const weatherLabel = (edid: string): string => {
  let s = edid.replace(/^(Skyrim|DLC1_Skyrim|DLC02)/, '');
  const notes: string[] = [];
  if (/_A$/.test(s)) {
    s = s.slice(0, -2);
    notes.push('aurora');
  }
  const m = s.match(/^(.+?)([A-Z]{2})$/);
  if (m && SUFFIXES[m[2]]) {
    s = m[1];
    notes.unshift(SUFFIXES[m[2]]);
  }
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return (words || edid) + (notes.length ? ' (' + notes.join(', ') + ')' : '');
};

const WeatherTab = ({ data, now, ev, send }: WeatherTabProps) => {
  const [form, setFormState] = useState(savedForm);

  const setForm = (next: typeof savedForm): void => {
    savedForm = next;
    setFormState(next);
  };

  const regions = data ? data.regions : [];
  const catalog = data ? data.weathers : [];
  const here = regions.find((r) => r.here) || null;
  // Blank region means where the admin stands
  const picked = form.region ? regions.find((r) => r.id === form.region) || null : here;
  const own = picked ? picked.weathers : [];
  const weatherOptions = own
    .map((w) => ({ value: w.desc, label: weatherLabel(w.edid) + ' · ' + w.chance + '%' }))
    .concat(catalog.filter((c) => !own.some((w) => w.desc === c.desc)).map((c) => ({ value: c.desc, label: weatherLabel(c.edid) })));
  const weatherPick = weatherOptions.some((o) => o.value === form.weather) ? form.weather : '';
  const regionOptions = [{ value: '', label: 'The region I am in' + (here ? ' (' + here.name + ')' : '') }].concat(
    regions.slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ value: r.id, label: r.name })));

  // Seconds left, counted down from the server's own clock at the moment the list was built
  const leftSec = (r: WeatherRegionRow): number =>
    data ? Math.max(0, Math.round((r.endsAt - data.at) / 1000 - (now - data.receivedAt) / 1000)) : 0;

  const statusText = (r: WeatherRegionRow): string => {
    const time = r.endsAt ? formatCountdown(leftSec(r)) : 'until cleared';
    const players = r.players + (r.players === 1 ? ' player' : ' players');
    return weatherLabel(r.weather) + ' · ' + (r.forced ? 'forced, ' + time : time) + ' · ' + players;
  };

  const canForce = !!(ev.weatherSet && picked && weatherPick && isMinutes(form.minutes));

  const force = (): void => {
    if (!canForce) return;
    send(ev.weatherSet, JSON.stringify({ region: form.region, weather: weatherPick, minutes: form.minutes.trim() }));
  };

  // The admin's own region first, then by name
  const rows = regions.slice().sort((a, b) => (a.here === b.here ? a.name.localeCompare(b.name) : a.here ? -1 : 1));

  return (
    <div className="admin-panel__body">
      <div className="admin-panel__list admin-panel__list--jobs">
        {!data ? (
          <div className="admin-panel__empty">Loading weather</div>
        ) : rows.length === 0 ? (
          <div className="admin-panel__empty">No weather regions (weatherEnabled is off)</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className={'admin-panel__row admin-panel__row--zone' + (picked && picked.id === r.id ? ' admin-panel__row--selected' : '')}>
              <div className="admin-panel__zone-info">
                <span className="admin-panel__cell admin-panel__cell--name" title={r.id}>{r.name + (r.here ? ' (here)' : '')}</span>
                <span className="admin-panel__cell admin-panel__cell--status" title={r.weather}>
                  <span className={'admin-panel__dot' + (r.forced ? ' admin-panel__dot--online' : '')} />
                  {statusText(r)}
                </span>
              </div>
              <div className="admin-panel__zone-buttons">
                <Button text="Pick" width={56} height={24} onClick={() => setForm({ ...form, region: r.id })} />
                <Button text="Clear" width={64} height={24} disabled={!ev.weatherClear} onClick={() => send(ev.weatherClear, r.id)} />
              </div>
            </div>
          ))
        )}
      </div>
      <div className="admin-panel__form">
        <div className="admin-panel__field admin-panel__field--half">
          Region
          <Dropdown
            value={form.region}
            options={regionOptions}
            disabled={!data}
            onChange={(region) => setForm({ ...form, region })}
          />
        </div>
        <div className="admin-panel__field admin-panel__field--half">
          Weather
          <Dropdown
            value={weatherPick}
            placeholder={picked ? 'Choose a weather' : 'Pick a region first'}
            options={weatherOptions}
            disabled={!picked}
            onChange={(weather) => setForm({ ...form, weather })}
          />
        </div>
        <label className="admin-panel__field admin-panel__field--half">
          Minutes (optional)
          <input
            className="admin-panel__input"
            placeholder="blank: until cleared"
            value={form.minutes}
            onChange={(e) => setForm({ ...form, minutes: e.target.value })}
          />
        </label>
      </div>
      <div className="admin-panel__actions">
        <Button text="Force" width={104} height={32} disabled={!canForce} onClick={force} />
        <Button text="Clear" width={104} height={32} disabled={!(ev.weatherClear && picked)} onClick={() => picked && send(ev.weatherClear, picked.id)} />
      </div>
      <span className="admin-panel__hint">
        Force holds the weather on the region for everyone in it until Clear, or for the minutes given (1 to {MAX_MINUTES}); Clear rolls one of the region&apos;s own weathers again. The picker lists the region&apos;s own weathers with their chances first, then every weather of the load order.
      </span>
    </div>
  );
};

export default WeatherTab;
