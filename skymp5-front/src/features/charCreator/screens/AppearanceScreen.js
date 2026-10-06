/* eslint-disable react/prop-types */
import React from 'react';

import { SkyrimSlider } from '../../../components/SkyrimSlider/SkyrimSlider';
import headparts from '../data/headparts.json';
import { findRace } from '../data/races';
import { FACE_MORPHS, FACE_PRESETS, TINT_TYPES } from '../data/face';
import { bodyRangesFor, toVanillaWeight } from '../data/stats';
import { partsFor, tintsFor, raceDefaultsFor } from '../appearanceBuilder';
import { loc } from '../../../loc';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rgbToHex = (rgb) => '#' + rgb.map(c => clamp(c, 0, 255).toString(16).padStart(2, '0')).join('');
const hexToRgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) || 0);

const MORPH_GROUPS = [
  { name: loc('charCreator.appearance.group.nose'), indices: [0, 1] },
  { name: loc('charCreator.appearance.group.jaw'), indices: [2, 3, 4] },
  { name: loc('charCreator.appearance.group.cheeks'), indices: [5, 6] },
  { name: loc('charCreator.appearance.group.eyes'), indices: [7, 8, 17] },
  { name: loc('charCreator.appearance.group.brows'), indices: [9, 10, 11] },
  { name: loc('charCreator.appearance.group.lips'), indices: [12, 13] },
  { name: loc('charCreator.appearance.group.chin'), indices: [14, 15, 16] }
];

const PART_KINDS = [
  { kind: 'hair', label: loc('charCreator.appearance.part.hair'), slot: 'hair', noneAllowed: true },
  { kind: 'eyes', label: loc('charCreator.appearance.part.eyes'), slot: 'eyes' },
  { kind: 'brows', label: loc('charCreator.appearance.part.brows'), slot: 'brows', noneAllowed: true },
  { kind: 'facialHair', label: loc('charCreator.appearance.part.facialHair') },
  { kind: 'scars', label: loc('charCreator.appearance.part.scars') }
];

const Carousel = ({ label, options, value, onChange }) => {
  const found = options.findIndex(o => o.value === value);
  const index = found < 0 ? 0 : found;
  const move = (dir) => {
    if (!options.length) return;
    onChange(options[(index + dir + options.length) % options.length].value);
  };
  return (
    <div className='charCreator__carousel'>
      <span className='charCreator__carousel-label'>{label}</span>
      <button className='charCreator__arrow' onClick={() => move(-1)}>&#9664;</button>
      <span className='charCreator__carousel-value'>{options[index] ? options[index].label : '-'}</span>
      <button className='charCreator__arrow' onClick={() => move(1)}>&#9654;</button>
    </div>
  );
};

const Swatches = ({ label, colors, current, onPick, onFree, noneAllowed }) => (
  <div className='charCreator__color-row'>
    <span className='charCreator__carousel-label'>{label}</span>
    <div className='charCreator__swatches'>
      {noneAllowed
        ? (
          <div
            className={'charCreator__swatch charCreator__swatch--none' + (current === null ? ' charCreator__swatch--selected' : '')}
            onClick={() => onPick(null)}
            title={loc('common.none')}
          />
          )
        : null}
      {colors.map((c, i) => (
        <div
          key={i}
          className={
            'charCreator__swatch' +
            (current && rgbToHex(current) === rgbToHex(c.rgb) ? ' charCreator__swatch--selected' : '')
          }
          style={{ background: rgbToHex(c.rgb) }}
          title={c.label || ''}
          onClick={() => onPick(c.rgb)}
        />
      ))}
      <input
        type='color'
        className='charCreator__color-input'
        value={current ? rgbToHex(current) : '#808080'}
        onChange={(e) => onFree(hexToRgb(e.target.value))}
      />
    </div>
  </div>
);

// FaceGen morphs live in [-1, 1]; the slider works in 0.05 ticks.
const MorphSlider = ({ name, value, onChange }) => (
  <div className='charCreator__slider'>
    <SkyrimSlider
      text={name}
      min={-20}
      max={20}
      sliderValue={Math.round(value * 20)}
      setValue={(v) => onChange(v / 20)}
    />
  </div>
);

// Body slider with the stat-locked range dimmed at both ends.
const BodySlider = ({ label, value, range, onChange }) => (
  <div className='charCreator__slider charCreator__body-slider'>
    <div className='charCreator__body-dim' style={{ left: 0, width: `${range.min}%` }} />
    <div className='charCreator__body-dim' style={{ left: `${range.max}%`, width: `${100 - range.max}%` }} />
    <SkyrimSlider
      text={`${label}: ${clamp(value, range.min, range.max)}`}
      min={0}
      max={100}
      sliderValue={clamp(value, range.min, range.max)}
      setValue={(v) => onChange(clamp(v, range.min, range.max))}
    />
  </div>
);

const AppearanceScreen = ({ race, sex, age, stats, look, onLook }) => {
  if (!race) return null;
  const ranges = bodyRangesFor(stats);
  const muscle = clamp(look.muscle, ranges.muscle.min, ranges.muscle.max);
  const fat = clamp(look.fat, ranges.fat.min, ranges.fat.max);

  const bodyBlock = (
    <div className='charCreator__section'>
      <div className='charCreator__section-label'>{loc('charCreator.appearance.body')}</div>
      <BodySlider label={loc('charCreator.appearance.muscle')} value={look.muscle} range={ranges.muscle} onChange={(v) => onLook({ muscle: v })} />
      <BodySlider label={loc('charCreator.appearance.fat')} value={look.fat} range={ranges.fat} onChange={(v) => onLook({ fat: v })} />
      <div className='charCreator__note'>{loc('charCreator.appearance.weight', { n: toVanillaWeight(muscle, fat) })}</div>
    </div>
  );

  if (!race.faceGen) {
    return (
      <div className='charCreator__screen'>
        <div className='charCreator__title'>{loc('charCreator.appearance.title')}</div>
        <div className='charCreator__note'>{loc('charCreator.appearance.naturalLook')}</div>
        {bodyBlock}
      </div>
    );
  }

  const species = findRace(race.id).species;
  const defaults = raceDefaultsFor(race, age, sex);

  const partCarousels = PART_KINDS.map(def => {
    if (def.kind === 'facialHair' && (sex !== 'male' || !['human', 'mer'].includes(species.id))) return null;
    const parts = partsFor(def.kind, race, age, sex);
    const defaultId = def.slot ? defaults[def.slot] : undefined;
    const options = [];
    if (def.noneAllowed || defaultId === undefined) options.push({ value: null, label: loc('common.none') });
    if (defaultId !== undefined && !parts.some(p => p.id === defaultId)) {
      options.push({ value: defaultId, label: loc('charCreator.appearance.default') });
    }
    for (const p of parts) options.push({ value: p.id, label: p.label });
    const onlyNone = options.length === 1 && options[0].value === null;
    if (!options.length || onlyNone) return null;
    return (
      <Carousel
        key={def.kind}
        label={def.label}
        options={options}
        value={look.parts[def.kind]}
        onChange={(id) => onLook({ parts: { ...look.parts, [def.kind]: id } })}
      />
    );
  });

  const skinPresets = (tintsFor(race, age, sex, TINT_TYPES.SKIN_TONE)[0] || { presets: [] }).presets;
  const lipPresets = (tintsFor(race, age, sex, TINT_TYPES.LIPS)[0] || { presets: [] }).presets;
  const warpaints = tintsFor(race, age, sex, TINT_TYPES.WARPAINT);
  const warpaintName = (file) => file.split('\\').pop().replace(/\.dds$/i, '');
  const warpaintOptions = [{ value: null, label: loc('common.none') }]
    .concat(warpaints.map(w => ({ value: w.file, label: warpaintName(w.file) })));

  const setMorph = (index, v) => {
    const morphs = [...look.morphs];
    morphs[index] = v;
    onLook({ morphs });
  };

  const setPreset = (index, v) => {
    const presets = [...look.presets];
    presets[index] = v;
    onLook({ presets });
  };

  const setWarpaint = (file) => {
    if (file === null) return onLook({ warpaint: null });
    const prev = look.warpaint || {};
    const tint = warpaints.find(w => w.file === file);
    const rgb = prev.rgb || (tint && tint.presets[0]) || [255, 255, 255];
    return onLook({ warpaint: { file, rgb, opacity: prev.opacity !== undefined ? prev.opacity : 60 } });
  };

  return (
    <div className='charCreator__screen'>
      <div className='charCreator__title'>{loc('charCreator.appearance.title')}</div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>{loc('charCreator.appearance.headParts')}</div>
        {partCarousels}
      </div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>{loc('charCreator.appearance.faceShape')}</div>
        {FACE_PRESETS.map(p => (
          <Carousel
            key={p.index}
            label={p.name}
            options={Array.from({ length: p.max + 1 }, (_, i) => ({ value: i, label: loc('charCreator.appearance.presetOf', { n: i + 1, total: p.max + 1 }) }))}
            value={look.presets[p.index]}
            onChange={(v) => setPreset(p.index, v)}
          />
        ))}
      </div>

      {MORPH_GROUPS.map(group => (
        <div key={group.name} className='charCreator__section'>
          <div className='charCreator__section-label'>{group.name}</div>
          {group.indices.map(i => (
            <MorphSlider
              key={i}
              name={FACE_MORPHS[i] ? FACE_MORPHS[i].name : ''}
              value={look.morphs[i]}
              onChange={(v) => setMorph(i, v)}
            />
          ))}
        </div>
      ))}

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>{loc('charCreator.appearance.colors')}</div>
        <Swatches
          label={loc('charCreator.appearance.skinTone')}
          colors={skinPresets.map(rgb => ({ rgb }))}
          current={look.skinRgb}
          onPick={(rgb) => onLook({ skinRgb: rgb })}
          onFree={(rgb) => onLook({ skinRgb: rgb })}
        />
        <Swatches
          label={loc('charCreator.appearance.hairColor')}
          colors={headparts.hairColors}
          current={look.hairRgb}
          onPick={(rgb) => onLook({ hairRgb: rgb })}
          onFree={(rgb) => onLook({ hairRgb: rgb })}
        />
        <Swatches
          label={loc('charCreator.appearance.lipColor')}
          colors={lipPresets.map(rgb => ({ rgb }))}
          current={look.lipRgb}
          onPick={(rgb) => onLook({ lipRgb: rgb })}
          onFree={(rgb) => onLook({ lipRgb: rgb })}
          noneAllowed
        />
      </div>

      {warpaints.length
        ? (
          <div className='charCreator__section'>
            <div className='charCreator__section-label'>{loc('charCreator.appearance.warpaint')}</div>
            <Carousel
              label={loc('charCreator.appearance.pattern')}
              options={warpaintOptions}
              value={look.warpaint ? look.warpaint.file : null}
              onChange={setWarpaint}
            />
            {look.warpaint
              ? (
                <>
                  <div className='charCreator__color-row'>
                    <span className='charCreator__carousel-label'>{loc('charCreator.appearance.paintColor')}</span>
                    <div className='charCreator__swatches'>
                      <input
                        type='color'
                        className='charCreator__color-input'
                        value={rgbToHex(look.warpaint.rgb)}
                        onChange={(e) => onLook({ warpaint: { ...look.warpaint, rgb: hexToRgb(e.target.value) } })}
                      />
                    </div>
                  </div>
                  <div className='charCreator__slider'>
                    <SkyrimSlider
                      text={loc('charCreator.appearance.opacity', { n: look.warpaint.opacity })}
                      min={0}
                      max={100}
                      sliderValue={look.warpaint.opacity}
                      setValue={(v) => onLook({ warpaint: { ...look.warpaint, opacity: v } })}
                    />
                  </div>
                </>
                )
              : null}
          </div>
          )
        : null}

      {bodyBlock}
    </div>
  );
};

export default AppearanceScreen;
