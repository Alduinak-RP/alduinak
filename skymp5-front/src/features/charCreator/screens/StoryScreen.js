/* eslint-disable react/prop-types */
import React from 'react';

import Button from '../../../constructorComponents/button';
import { loc } from '../../../loc';

const NAME_MAX = 30;
const BACKSTORY_MAX = 4000;
const DESCRIPTION_MAX = 1000;
const NAME_CHARS = /^[A-Za-z' -]+$/;

// Mirrors the server: it trims first and requires at least one letter.
const nameError = (rawName) => {
  const name = rawName.trim();
  if (name.length < 2) return loc('charCreator.story.nameShort');
  if (name.length > NAME_MAX) return loc('charCreator.story.nameLong');
  if (!NAME_CHARS.test(name)) return loc('charCreator.story.nameChars');
  if (!/[A-Za-z]/.test(name)) return loc('charCreator.story.nameLetters');
  return null;
};

const StoryScreen = ({ name, backstory, description, waiting, error, onChange, onFinish }) => {
  const nameMsg = nameError(name);
  const valid = !nameMsg && backstory.length <= BACKSTORY_MAX && description.length <= DESCRIPTION_MAX;

  const finish = () => {
    if (!valid || waiting) return;
    onFinish();
  };

  return (
    <div className='charCreator__screen'>
      <div className='charCreator__title'>{loc('charCreator.story.title')}</div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>{loc('charCreator.story.name')}</div>
        <input
          className='charCreator__text-input'
          type='text'
          value={name}
          maxLength={NAME_MAX}
          spellCheck='false'
          placeholder={loc('charCreator.story.namePlaceholder')}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {name && nameMsg ? <div className='charCreator__error'>{nameMsg}</div> : null}
      </div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>
          {loc('charCreator.story.backstory')}
          <span className='charCreator__counter'>{backstory.length} / {BACKSTORY_MAX}</span>
        </div>
        <textarea
          className='charCreator__textarea charCreator__textarea--tall'
          value={backstory}
          maxLength={BACKSTORY_MAX}
          spellCheck='false'
          placeholder={loc('charCreator.story.backstoryPlaceholder')}
          onChange={(e) => onChange({ backstory: e.target.value })}
        />
      </div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>
          {loc('charCreator.story.description')}
          <span className='charCreator__counter'>{description.length} / {DESCRIPTION_MAX}</span>
        </div>
        <textarea
          className='charCreator__textarea'
          value={description}
          maxLength={DESCRIPTION_MAX}
          spellCheck='false'
          placeholder={loc('charCreator.story.descriptionPlaceholder')}
          onChange={(e) => onChange({ description: e.target.value })}
        />
        <div className='charCreator__note'>{loc('charCreator.story.descriptionNote')}</div>
      </div>

      {error ? <div className='charCreator__error'>{error}</div> : null}
      <div className='charCreator__finish'>
        {waiting
          ? <div className='charCreator__waiting'>{loc('charCreator.story.forging')}</div>
          : <Button text={loc('charCreator.story.finish')} width={192} height={44} disabled={!valid} onClick={finish} />}
      </div>
    </div>
  );
};

export default StoryScreen;
