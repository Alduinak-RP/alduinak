import React from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface InteractPromptData {
  verb: string;
  label: string;
}

const InteractPrompt = ({ data }: { data: InteractPromptData }) => {
  if (!data.verb || !data.label) return null;
  return (
    <div className="interactPrompt">
      <span className="interactPrompt__verb">{data.verb}</span>
      <span className="interactPrompt__label">{data.label}</span>
    </div>
  );
};

export default InteractPrompt;
