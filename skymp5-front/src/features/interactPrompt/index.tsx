import React from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface InteractPromptData {
  verb: string;
  label: string;
  // The verb alone as one sentence-case line, as a passive job offer reads
  line?: boolean;
}

const InteractPrompt = ({ data }: { data: InteractPromptData }) => {
  if (!data.verb || (!data.label && !data.line)) return null;
  return (
    <div className="interactPrompt">
      <span className={data.line ? 'interactPrompt__line' : 'interactPrompt__verb'}>{data.verb}</span>
      {!data.line && <span className="interactPrompt__label">{data.label}</span>}
    </div>
  );
};

export default InteractPrompt;
