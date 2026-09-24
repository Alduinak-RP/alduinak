import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import { SkyrimFrame } from '../../../components/SkyrimFrame/SkyrimFrame';
import { SkyrimSlider } from '../../../components/SkyrimSlider/SkyrimSlider';
import CheckBox from '../../checkbox/index';
import { DOM_TO_DIK, MOUSE_TO_DIK, dikLabel, canHold } from '../../../utils/dxScanCodes';
import './styles.scss';

const SETTINGS_TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'ui', label: 'Graphics / UI' },
  { id: 'controls', label: 'Controls' },
];

// Rebindable keys: chat settings `keys` name (the launcher's skymp5-client setting) -> row label
const KEY_ROWS: [string, string][] = [
  ['emoteWheelKeyCode', 'Emote wheel'],
  ['altInteractKeyCode', 'Interact / Menus'],
  ['hideUiKeyCode', 'Hide interface'],
  ['freeCursorKeyCode', 'Free cursor'],
  ['voicePushToTalkKeyCode', 'Voice push-to-talk'],
  ['chatFocusKeyCode', 'Chat'],
  ['bountyBoardMenuKeyCode', 'Bounty board'],
];

// The launcher's CLIENT_FIXED_KEYS (skymp5-launcher renderer.js) without the bounty board, which is a row here
const CLIENT_FIXED_KEYS: Record<number, string> = {
  1: 'menu close', 15: 'game menu', 28: 'Chat',
  17: 'emote cancel', 30: 'emote cancel', 31: 'emote cancel', 32: 'emote cancel', 57: 'emote cancel', 19: 'emote cancel',
};

export type KeyOverrides = Record<string, number>;

const Settings = (props: {
  fontSize: number,
  setFontSize: (size: number) => void,
  lockChat: boolean,
  setLockChat: (value: boolean) => void,
  showPlayerNames: boolean,
  setShowPlayerNames: (value: boolean) => void,
  showFormIds: boolean,
  setShowFormIds: (value: boolean) => void,
  chatTransparency: number,
  setChatTransparency: (value: number) => void,
  fadeSeconds: number,
  setFadeSeconds: (value: number) => void,
  fadeText: boolean,
  setFadeText: (value: boolean) => void,
  customHighlights: string,
  setCustomHighlights: (value: string) => void,
  fov: number | null,
  setFov: (value: number) => void,
  // In-game rebinds; a missing name uses the launcher's key
  keys: KeyOverrides,
  setKeys: (value: KeyOverrides) => void,
  keysLauncher: KeyOverrides,
  // Hold the key to keep the menu open instead of toggling it
  emoteWheelHold: boolean,
  setEmoteWheelHold: (value: boolean) => void,
  interactMenuHold: boolean,
  setInteractMenuHold: (value: boolean) => void,
  onBack: () => void,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(520);
  const [tab, setTab] = useState(SETTINGS_TABS[0].id);
  // The key row waiting for a press, if any
  const [capturing, setCapturing] = useState('');
  // Auto-size the frame to its content so everything fits without a scrollbar.
  useLayoutEffect(() => {
    if (contentRef.current) setFrameHeight(Math.ceil(contentRef.current.scrollHeight) + 64);
  }, [tab, props.keys]);

  const keyOf = (name: string, keys = props.keys) => keys[name] || props.keysLauncher[name] || 0;
  const noHold = (name: string, keys = props.keys) => !canHold(keyOf(name, keys));
  // An unbound menu key cannot be held, so its hold option is dropped with the rebind
  const applyKeys = (next: KeyOverrides) => {
    props.setKeys(next);
    if (noHold('emoteWheelKeyCode', next)) props.setEmoteWheelHold(false);
    if (noHold('altInteractKeyCode', next)) props.setInteractMenuHold(false);
  };

  // Same capture as the launcher's Settings tab: Esc cancels, Backspace returns the row to the launcher's key
  useEffect(() => {
    if (!capturing) return;
    const finish = (dik?: number) => {
      setCapturing('');
      if (dik === undefined) return;
      const next = { ...props.keys };
      if (dik) next[capturing] = dik;
      else delete next[capturing];
      applyKeys(next);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.code === 'Escape') return finish();
      if (e.code === 'Backspace') return finish(0);
      const entry = DOM_TO_DIK[e.code];
      if (entry) finish(entry[0]);
    };
    const onMouse = (e: MouseEvent) => {
      const entry = MOUSE_TO_DIK[e.button];
      if (!entry) return finish();
      e.preventDefault();
      e.stopPropagation();
      finish(entry[0]);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('mouseup', onMouse, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('mouseup', onMouse, { capture: true });
    };
  }, [capturing, props.keys]);

  // Same warning as the launcher's showHotkeyConflict; shared keys still save
  const uses = new Map<number, Set<string>>();
  for (const [name, label] of KEY_ROWS) {
    const code = keyOf(name);
    if (!code) continue;
    if (!uses.has(code)) uses.set(code, new Set(CLIENT_FIXED_KEYS[code] ? [CLIENT_FIXED_KEYS[code]] : []));
    uses.get(code)!.add(label);
  }
  const shared = [...uses].filter(([, names]) => names.size > 1).map(([code, names]) => `${dikLabel(code)} (${[...names].join(', ')})`);
  const sharedWarning = shared.length ? `Each of these keys does more than one thing on the same press: ${shared.join('; ')}.` : '';

  return (
    <div className='chat-settings' style={{ height: `${frameHeight}px` }}>
      <button
        type='button'
        className='chat-settings-btn chat-settings-back'
        title='Back'
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onBack()}
      >
        {'Back'}
      </button>
      <div className='content' ref={contentRef}>
        <div className='chat-channels chat-settings-tabs'>
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t.id)}
              className={`chat-channel ${tab === t.id ? 'active' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'chat' && <>
          <SkyrimSlider text={'font size'} name={'fontSize'} min={14} max={22} setValue={(value) => props.setFontSize(value)} sliderValue={props.fontSize} marks={[14, 15, 16, 17, 18, 19, 20, 21, 22]}/>
          <SkyrimSlider text={'transparency'} name={'transparency'} min={0} max={80} setValue={(value) => props.setChatTransparency(value)} sliderValue={props.chatTransparency} marks={[0, 20, 40, 60, 80]}/>
          <SkyrimSlider text={'fade (seconds, 0 = never)'} name={'fadeSeconds'} min={0} max={60} setValue={(value) => props.setFadeSeconds(value)} sliderValue={props.fadeSeconds} marks={[0, 10, 20, 30, 45, 60]}/>
          <CheckBox text={'fade the text too'} initialValue={props.fadeText} setChecked={props.setFadeText} disabled={false} />
          <CheckBox text={'lock chat'} initialValue={props.lockChat} setChecked={props.setLockChat} disabled={false} />
          <div className='chat-highlights'>
            <span className='chat-highlights-label'>highlight words</span>
            <textarea
              className='chat-highlights-input'
              value={props.customHighlights}
              placeholder={'gold, "Aria", trad*'}
              onChange={(e) => props.setCustomHighlights(e.target.value)}
            />
          </div>
        </>}
        {tab === 'ui' && <>
          <SkyrimSlider text={'field of view'} name={'fov'} min={70} max={170} setValue={(value) => props.setFov(value)} sliderValue={props.fov ?? 80} marks={[70, 90, 110, 130, 150, 170]}/>
          <CheckBox text={'show player names'} initialValue={props.showPlayerNames} setChecked={props.setShowPlayerNames} disabled={false} />
          <CheckBox text={'show form ids'} initialValue={props.showFormIds} setChecked={props.setShowFormIds} disabled={false} />
        </>}
        {tab === 'controls' && <>
          {KEY_ROWS.map(([name, label]) => (
            <div key={name} className='chat-key-row'>
              <span className='chat-key-label'>{label}</span>
              <button
                type='button'
                className={`chat-settings-btn chat-key-btn ${capturing === name ? 'capturing' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setCapturing(name)}
              >
                {capturing === name ? 'Press a key...' : dikLabel(keyOf(name))}
              </button>
            </div>
          ))}
          <CheckBox key={`wheelHold-${keyOf('emoteWheelKeyCode')}`} text={'hold the emote wheel key' + (noHold('emoteWheelKeyCode') ? ' (not for this key)' : '')} initialValue={props.emoteWheelHold} setChecked={props.setEmoteWheelHold} disabled={noHold('emoteWheelKeyCode')} />
          <CheckBox key={`interactHold-${keyOf('altInteractKeyCode')}`} text={'hold the interact key for its menus' + (noHold('altInteractKeyCode') ? ' (not for this key)' : '')} initialValue={props.interactMenuHold} setChecked={props.setInteractMenuHold} disabled={noHold('altInteractKeyCode')} />
          <div className='chat-key-row'>
            <span className='chat-key-label'>Esc cancels, Backspace resets a row</span>
            <button
              type='button'
              className='chat-settings-btn'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyKeys({})}
            >
              {'Use launcher defaults'}
            </button>
          </div>
          {sharedWarning && <div className='chat-key-warning'>{sharedWarning}</div>}
        </>}
      </div>
      <SkyrimFrame width={512} height={frameHeight} header={false} name={'Settings'}/>
    </div>
  );
};

export default Settings;
