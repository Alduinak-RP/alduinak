/* eslint-disable react/prop-types */
import React, { useState, useEffect, useRef } from 'react';

import Button from '../../constructorComponents/button';
import { findRace } from './data/races';
import { defaultStats, DEFAULT_STAT_POOL } from './data/stats';
import { buildAppearance, defaultLook, defaultParts, clampedBody } from './appearanceBuilder';
import SpeciesScreen from './screens/SpeciesScreen';
import RaceScreen from './screens/RaceScreen';
import IdentityScreen from './screens/IdentityScreen';
import AppearanceScreen from './screens/AppearanceScreen';
import StoryScreen from './screens/StoryScreen';
import './styles.scss';

const STEPS = ['Species', 'Race', 'Identity', 'Appearance', 'Story'];

export const send = (key, ...args) => {
  try {
    window.skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('charCreator sendMessage', key, args);
  }
};

const CharCreator = ({ data }) => {
  const config = data.config || {};
  const statPool = Number.isInteger(config.statPool) && config.statPool >= 0
    ? config.statPool
    : DEFAULT_STAT_POOL;

  const [state, setState] = useState(() => ({
    step: 1,
    species: null,
    race: null,
    sex: 'male',
    age: 'adult',
    stats: defaultStats(),
    look: defaultLook(null, 'adult', 'male'),
    name: '',
    backstory: '',
    description: ''
  }));

  const update = (patch) => setState(s => ({ ...s, ...patch }));

  const setSpecies = (speciesId) => setState(s => (
    s.species === speciesId ? s : { ...s, species: speciesId, race: null }
  ));

  const setRace = (raceSlug) => setState(s => {
    const found = findRace(raceSlug);
    return { ...s, race: raceSlug, look: defaultLook(found.race, s.age, s.sex) };
  });

  const resetSexAge = (s, sex, age) => {
    if (!s.race) return s.look;
    const race = findRace(s.race).race;
    return { ...s.look, parts: defaultParts(race, age, sex), warpaint: null };
  };

  const setSex = (sex) => setState(s => ({ ...s, sex, look: resetSexAge(s, sex, s.age) }));
  const setAge = (age) => setState(s => ({ ...s, age, look: resetSexAge(s, s.sex, age) }));
  const setLook = (patch) => setState(s => ({ ...s, look: { ...s.look, ...patch } }));

  const race = state.race ? findRace(state.race).race : null;
  const locked = config.lockedRaces || [];

  const canNext = () => {
    if (state.step === 1) return !!state.species;
    if (state.step === 2) return !!state.race && !locked.includes(state.race);
    return state.step < 5;
  };

  const [waiting, setWaiting] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  useEffect(() => {
    const onError = (e) => {
      setWaiting(false);
      setSaveError((e.detail && (e.detail.message || e.detail)) || 'The server rejected this character.');
    };
    window.addEventListener('charCreator:error', onError);
    return () => window.removeEventListener('charCreator:error', onError);
  }, []);

  const back = () => {
    if (waitingRef.current) return;
    setState(s => ({ ...s, step: Math.max(1, s.step - 1) }));
  };
  const next = () => setState(s => ({ ...s, step: Math.min(5, s.step + 1) }));

  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') backRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Live preview: debounced push of the current appearance to the client.
  useEffect(() => {
    if (state.step < 3 || !state.race) return;
    const timer = setTimeout(() => {
      send('charCreator:preview', JSON.stringify(buildAppearance(state)));
    }, 200);
    return () => clearTimeout(timer);
  }, [state.race, state.sex, state.age, state.look, state.stats, state.step]);

  const save = () => {
    if (waitingRef.current) return;
    setSaveError(null);
    setWaiting(true);
    const name = state.name.trim();
    const payload = {
      race: state.race,
      sex: state.sex,
      age: state.age,
      stats: state.stats,
      bodyExtras: clampedBody(state),
      appearance: buildAppearance({ ...state, name }),
      name,
      backstory: state.backstory,
      description: state.description
    };
    send('charCreator:save', JSON.stringify(payload));
  };

  const renderScreen = () => {
    switch (state.step) {
      case 1:
        return (
          <SpeciesScreen
            selected={state.species}
            disabledRaces={config.disabledRaces || []}
            onSelect={setSpecies}
          />
        );
      case 2:
        return (
          <RaceScreen
            species={state.species}
            selected={state.race}
            disabledRaces={config.disabledRaces || []}
            lockedRaces={locked}
            onSelect={setRace}
          />
        );
      case 3:
        return (
          <IdentityScreen
            sex={state.sex}
            age={state.age}
            stats={state.stats}
            statPool={statPool}
            allowChildren={!!config.allowChildren}
            onSex={setSex}
            onAge={setAge}
            onStats={(next) => setState(s => ({ ...s, stats: typeof next === 'function' ? next(s.stats) : next }))}
          />
        );
      case 4:
        return (
          <AppearanceScreen
            race={race}
            sex={state.sex}
            age={state.age}
            stats={state.stats}
            look={state.look}
            onLook={setLook}
          />
        );
      case 5:
        return (
          <StoryScreen
            name={state.name}
            backstory={state.backstory}
            description={state.description}
            waiting={waiting}
            error={saveError}
            onChange={update}
            onFinish={save}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className='charCreator'>
      <div className='charCreator__panel'>
        <div className='charCreator__steps'>
          {STEPS.map((label, i) => (
            <div
              key={label}
              className={'charCreator__step' + (state.step === i + 1 ? ' charCreator__step--active' : '')}
            >
              <span className='charCreator__step-num'>{i + 1}</span> {label}
            </div>
          ))}
        </div>
        <div className='charCreator__content'>{renderScreen()}</div>
        <div className='charCreator__footer'>
          <Button text='Back' width={128} height={40} disabled={state.step === 1 || waiting} onClick={back} />
          {state.step < 5
            ? <Button text='Next' width={128} height={40} disabled={!canNext()} onClick={next} />
            : null}
        </div>
      </div>
    </div>
  );
};

export default CharCreator;
