import React from 'react';
import { SkyrimHintProps } from '../../interfaces/buttons';
import { assetUrl } from '../../utils/assetUrl';
import './SkyrimHint.scss';

export const SkyrimHint = (
  { isOpened = false, text = '', active, left }: SkyrimHintProps
) => {
  return (
    <div
      className={`skymp-hint ${active ? 'active' : 'disabled'} ${
        left ? 'left' : ''
      }`}
      style={{
        backgroundImage: `url(${assetUrl(require('../../img/hint.svg'))})`,
        display: isOpened ? 'flex' : 'none'
      }}
    >
      <span className={'skymp-hint--text'}>{text}</span>
    </div>
  );
};
