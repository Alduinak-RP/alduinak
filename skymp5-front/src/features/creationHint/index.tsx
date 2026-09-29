import React, { useLayoutEffect } from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets while the vanilla race menu is open.
export interface CreationHintData {
  text: string;
}

// The only part of the page shown over the race menu: the body class hides everything else while it is mounted
const CreationHint = ({ data }: { data: CreationHintData }) => {
  useLayoutEffect(() => {
    document.body.classList.add('creationHint-only');
    return () => document.body.classList.remove('creationHint-only');
  }, []);
  if (!data.text) return null;
  return <div className="creationHint">{data.text}</div>;
};

export default CreationHint;
