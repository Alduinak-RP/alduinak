/* eslint-disable react/prop-types */
import React from 'react';

import Button from '../../../constructorComponents/button';

const NAME_MAX = 30;
const BACKSTORY_MAX = 4000;
const DESCRIPTION_MAX = 1000;
const NAME_CHARS = /^[A-Za-z' -]+$/;

// Mirrors the server: it trims first and requires at least one letter.
const nameError = (rawName) => {
  const name = rawName.trim();
  if (name.length < 2) return 'Name must be at least 2 characters.';
  if (name.length > NAME_MAX) return 'Name must be at most 30 characters.';
  if (!NAME_CHARS.test(name)) return "Only letters, spaces, ' and - are allowed.";
  if (!/[A-Za-z]/.test(name)) return 'Name must contain letters.';
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
      <div className='charCreator__title'>Your story</div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>Name</div>
        <input
          className='charCreator__text-input'
          type='text'
          value={name}
          maxLength={NAME_MAX}
          spellCheck='false'
          placeholder='Character name'
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {name && nameMsg ? <div className='charCreator__error'>{nameMsg}</div> : null}
      </div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>
          Backstory
          <span className='charCreator__counter'>{backstory.length} / {BACKSTORY_MAX}</span>
        </div>
        <textarea
          className='charCreator__textarea charCreator__textarea--tall'
          value={backstory}
          maxLength={BACKSTORY_MAX}
          spellCheck='false'
          placeholder='Where do you come from? Kept private for staff and your own records.'
          onChange={(e) => onChange({ backstory: e.target.value })}
        />
      </div>

      <div className='charCreator__section'>
        <div className='charCreator__section-label'>
          Description
          <span className='charCreator__counter'>{description.length} / {DESCRIPTION_MAX}</span>
        </div>
        <textarea
          className='charCreator__textarea'
          value={description}
          maxLength={DESCRIPTION_MAX}
          spellCheck='false'
          placeholder='What a stranger sees at a glance.'
          onChange={(e) => onChange({ description: e.target.value })}
        />
        <div className='charCreator__note'>Strangers see this when they are introduced to you.</div>
      </div>

      {error ? <div className='charCreator__error'>{error}</div> : null}
      <div className='charCreator__finish'>
        {waiting
          ? <div className='charCreator__waiting'>Forging your character&hellip;</div>
          : <Button text='Finish' width={192} height={44} disabled={!valid} onClick={finish} />}
      </div>
    </div>
  );
};

export default StoryScreen;
