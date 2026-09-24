import React, { useRef, useState, useLayoutEffect } from 'react';
import { SkyrimFrame } from '../../../components/SkyrimFrame/SkyrimFrame';
import { SkyrimSlider } from '../../../components/SkyrimSlider/SkyrimSlider';
import CheckBox from '../../checkbox/index';
import './styles.scss';

const SETTINGS_TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'ui', label: 'Graphics / UI' },
];

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
  onBack: () => void,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(520);
  const [tab, setTab] = useState(SETTINGS_TABS[0].id);
  // Auto-size the frame to its content so everything fits without a scrollbar.
  useLayoutEffect(() => {
    if (contentRef.current) setFrameHeight(Math.ceil(contentRef.current.scrollHeight) + 64);
  }, [tab]);
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
      </div>
      <SkyrimFrame width={512} height={frameHeight} header={false} name={'Settings'}/>
    </div>
  );
};

export default Settings;
