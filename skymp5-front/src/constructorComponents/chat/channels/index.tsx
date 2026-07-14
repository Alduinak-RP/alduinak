import React from 'react';
import './styles.scss';

export interface ChatChannel {
  // Identifier used internally and persisted as the active channel.
  id: string;
  // Short label shown on the selector button.
  label: string;
  // Slash-command prefix for outgoing messages; empty string sends verbatim (the server treats unprefixed text as /say).
  cmd: string;
  // Extra class colouring the active channel, mirroring the message colours in ../styles.scss (.action, .admin, ...).
  className: string;
}

export const CHAT_CHANNELS: ChatChannel[] = [
  { id: 'local',    label: 'Local',    cmd: '',          className: 'channel-local' },
  // System: read-only feed of vanilla notifications, admin /system broadcasts and flavour text. Not typeable. (#eda841)
  { id: 'system',   label: 'System',   cmd: '',          className: 'channel-system' },
  // Admin-to-admin chat, hidden from normal players.
  { id: 'admin',    label: 'Admin',    cmd: '/admin ',   className: 'channel-admin' },
  { id: 'personal', label: 'Personal', cmd: '/pm ',      className: 'channel-pm' },
];

// Tabs only admins may see/use.
export const ADMIN_ONLY_CHANNELS = ['admin'];

// The read-only notifications tab.
export const SYSTEM_CHANNEL = 'system';

export const DEFAULT_CHANNEL = CHAT_CHANNELS[0].id; // 'local'

// Slash-commands routed to the Personal and Admin tabs
const PERSONAL_CMDS = ['pm', 'dm', 'to', 'too'];
const ADMIN_CMDS = ['admin'];
const LOCAL_CMDS = [
  'say', 'low', 'l', 'whisper', 'w', 'wide', 'long', 'shout', 's', 'y', 'yell',
  'me', 'melow', 'mel', 'melong', 'mewide', 'mew',
  'my', 'mylow', 'myl', 'mylong', 'mywide', 'myw',
  'do', 'dolow', 'dol', 'dolong', 'dowide', 'dow',
  'ooc', 'looc', 'b', 'ooclow', 'looclow', 'oocl', 'bl', 'loocl', 'blow',
  'ooclong', 'looclong', 'oocw', 'bw', 'loocw', 'bwide', 'loocwide', 'blong',
];

// Applies the active channel's prefix to a message. Keeps it in the channel.
export const applyChannel = (text: string, channelId: string): string => {
  if (text.startsWith('/')) {
    return text;
  }
  const channel = CHAT_CHANNELS.find((c) => c.id === channelId);
  return channel && channel.cmd ? channel.cmd + text : text;
};

// Which tab an outgoing message lands in, so the active tab can follow it.
export const channelForMessage = (text: string): string | null => {
  if (!text || text.charAt(0) !== '/') return 'local'; // no slash = /say = Local
  const i = text.indexOf(' ');
  const cmd = (i < 0 ? text : text.slice(0, i)).slice(1).toLowerCase();
  if (PERSONAL_CMDS.includes(cmd)) return 'personal';
  if (ADMIN_CMDS.includes(cmd)) return (window as any).__skyrpAdmin ? 'admin' : null;
  if (LOCAL_CMDS.includes(cmd)) return 'local';
  return null;
};

const Channels = (props: {
  active: string,
  onSelect: (id: string) => void,
  unread?: Record<string, boolean>,
}) => {
  return (
    <div className="chat-channels">
      {CHAT_CHANNELS
        .filter((channel) => !ADMIN_ONLY_CHANNELS.includes(channel.id) || (window as any).__skyrpAdmin)
        .map((channel) => (
          <button
            key={channel.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onSelect(channel.id)}
            className={`chat-channel ${channel.className} ${props.active === channel.id ? 'active' : ''}`}
          >
            {channel.label}
            {props.unread && props.unread[channel.id] && props.active !== channel.id
              ? <span className="chat-channel-unread" /> : null}
          </button>
        ))}
    </div>
  );
};

export default Channels;
