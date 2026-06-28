import React, { useRef, useState, useLayoutEffect } from 'react';
import { SkyrimFrame } from '../../../components/SkyrimFrame/SkyrimFrame';
import { SkyrimSlider } from '../../../components/SkyrimSlider/SkyrimSlider';
import CheckBox from '../../checkbox/index';
import './styles.scss';

const Settings = (props: {
  fontSize: number,
  setFontSize: (size: number) => void,
  isSoundsDisabled: boolean,
  setDisableSounds: (disable: boolean) => void,
  lockChat: boolean,
  setLockChat: (value: boolean) => void,
  chatTransparency: number,
  setChatTransparency: (value: number) => void,
  customHighlights: string,
  setCustomHighlights: (value: string) => void,
  onBack: () => void,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(520);
  // Auto-size the frame to its content so everything fits without a scrollbar.
  useLayoutEffect(() => {
    if (contentRef.current) setFrameHeight(Math.ceil(contentRef.current.scrollHeight) + 64);
  }, []);
  return (
    <div className='chat-settings' style={{ height: `${frameHeight}px` }}>
      <button
        type='button'
        className='chat-settings-back'
        title='Back'
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onBack()}
      >
        {'Back'}
      </button>
      <div className='content' ref={contentRef}>
        <SkyrimSlider text={'font size'} name={'fontSize'} min={14} max={22} setValue={(value) => props.setFontSize(value)} sliderValue={props.fontSize} marks={[14, 15, 16, 17, 18, 19, 20, 21, 22]}/>
        <SkyrimSlider text={'transparency'} name={'transparency'} min={0} max={80} setValue={(value) => props.setChatTransparency(value)} sliderValue={props.chatTransparency} marks={[0, 20, 40, 60, 80]}/>
        <CheckBox text={'dice sounds'} initialValue={!props.isSoundsDisabled} setChecked={(value) => props.setDisableSounds(!value)} disabled={false} />
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
      </div>
      <SkyrimFrame width={512} height={frameHeight} header={false} name={'Settings'}/>
    </div>
  );
};

export default Settings;
