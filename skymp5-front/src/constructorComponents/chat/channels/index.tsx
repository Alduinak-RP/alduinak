import React from 'react';
import './styles.scss';

export interface ChatChannel {
  // Identifier used internally and persisted as the active channel.
  id: string;
  // Short label shown on the selector button.
  label: string;
  // Slash-command prefix prepended to outgoing messages for this channel.
  // An empty string means the message is sent verbatim (the server treats
  // unprefixed text as /say), preserving the historical default behaviour.
  cmd: string;
  // Extra class used to colour the active channel, mirroring the message
  // colours already defined in ../styles.scss (.action, .admin, ...).
  className: string;
}

// The default channel is "say" (first entry). Order here is the render order.
// Commands match the Frostfall gamemode's chat channels (/me, /ooc, /f).
export const CHAT_CHANNELS: ChatChannel[] = [
  { id: 'say', label: 'Say', cmd: '', className: 'channel-say' },
  { id: 'ooc', label: 'OOC', cmd: '/ooc ', className: 'channel-looc' },
  { id: 'me', label: 'Me', cmd: '/me ', className: 'channel-me' },
  { id: 'faction', label: 'Faction', cmd: '/f ', className: 'channel-admin' },
];

export const DEFAULT_CHANNEL = CHAT_CHANNELS[0].id;

// Applies the active channel's prefix to a message. If the player typed an
// explicit slash-command we respect it and add no prefix, so manual commands
// like "/me waves" or "/roll" keep working regardless of the selected channel.
export const applyChannel = (text: string, channelId: string): string => {
  if (text.startsWith('/')) {
    return text;
  }
  const channel = CHAT_CHANNELS.find((c) => c.id === channelId);
  return channel && channel.cmd ? channel.cmd + text : text;
};

const Channels = (props: {
  active: string,
  onSelect: (id: string) => void,
}) => {
  return (
    <div className="chat-channels">
      {CHAT_CHANNELS.map((channel) => (
        <button
          key={channel.id}
          type="button"
          // Keep the chat input focused when switching channels.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onSelect(channel.id)}
          className={`chat-channel ${channel.className} ${props.active === channel.id ? 'active' : ''}`}
        >
          {channel.label}
        </button>
      ))}
    </div>
  );
};

export default Channels;
