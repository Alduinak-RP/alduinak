import React, { useState } from 'react';

import Button from '../../constructorComponents/button';

// One roster row as built by the server (factionSystem.ts MemberView); every flag is the server's decision
export interface FactionMember {
  key: string;
  profileId: number;
  slot: number | null; // null: the rank is shared by every character of the account
  name: string;
  rankSlug: string;
  rankName: string;
  online: boolean;
  self: boolean;
  promote: string; // rank id a Promote click grants, '' when none
  demote: string;
  setRanks: string[]; // rank ids the viewer may set directly
  canRemove: boolean;
  canUniform: boolean;
}

export interface FactionDetail {
  id: string;
  name: string;
  zone: string;
  color: string;
  myRank: string; // '' when viewing as staff without a rank
  staff: boolean;
  ranks: Array<{ slug: string; name: string; capacity: number | null; count: number }>;
  members: FactionMember[];
  canLeave: boolean;
  inviteRanks: Array<{ slug: string; name: string }>; // ranks the viewer may invite to, lowest last
  nearby: Array<{ target: number; name: string }>; // players in invite range who are not members
}

// The factionMenu packet
export interface FactionMenuData {
  available: boolean;
  factions: Array<{ id: string; name: string; zone: string; color: string; rank: string }>;
  selected: string;
  chat: string; // the faction /f speaks to
  detail: FactionDetail | null;
}

interface FactionTabProps {
  data: FactionMenuData | null;
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
}

const ZONES: Record<string, string> = { west: 'West', east: 'East', neutral: 'Neutral' };

const FactionTab = ({ data, ev, send }: FactionTabProps) => {
  const [confirm, setConfirm] = useState('');
  const [inviteRank, setInviteRank] = useState('');

  if (!data) return <div className="admin-panel__empty">Loading factions</div>;
  if (!data.available) return <div className="admin-panel__empty">Factions are unavailable right now.</div>;
  const detail = data.detail;
  if (!data.factions.length || !detail) {
    return (
      <div className="admin-panel__empty admin-panel__empty--placeholder">
        You are not in a faction. An officer can invite you: they look at you, press the interact key and choose Invite to faction.
      </div>
    );
  }

  const rankName = (slug: string): string => (detail.ranks.find((r) => r.slug === slug) || { name: slug }).name;
  const act = (payload: Record<string, unknown>): void => {
    setConfirm('');
    send(ev.faction, JSON.stringify(Object.assign({ factionId: detail.id }, payload)));
  };
  const target = (m: FactionMember) => ({ profileId: m.profileId, slot: m.slot });
  const member = detail.myRank !== '';
  const inviteRanks = detail.inviteRanks || [];
  const nearby = detail.nearby || [];
  // The lowest rank until the player picks another
  const pickedRank = inviteRanks.some((r) => r.slug === inviteRank) ? inviteRank : inviteRanks.length ? inviteRanks[inviteRanks.length - 1].slug : '';

  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        {data.factions.length > 1 ? (
          <select className="admin-panel__input admin-panel__faction-pick" value={detail.id} onChange={(e) => send(ev.factionMenu, e.target.value)}>
            {data.factions.map((f) => (
              <option key={f.id} value={f.id}>{f.name + (f.rank ? ' (' + f.rank + ')' : '')}</option>
            ))}
          </select>
        ) : null}
        <span className="admin-panel__faction-name" style={{ color: '#' + detail.color }}>{detail.name}</span>
        {ZONES[detail.zone] ? <span className="admin-panel__faction-badge">{ZONES[detail.zone]}</span> : null}
        <span className="admin-panel__hint">{member ? 'Your rank: ' + detail.myRank : 'Staff view'}</span>
        <div className="admin-panel__filters admin-panel__filters--end admin-panel__actions">
          {member && data.chat !== detail.id ? <Button text="Use for /f" width={120} height={32} onClick={() => act({ action: 'chat' })} /> : null}
          {member && data.chat === detail.id ? <span className="admin-panel__hint">/f speaks here</span> : null}
          {detail.canLeave ? (
            confirm === 'leave'
              ? <Button text="Confirm leave" width={150} height={32} onClick={() => act({ action: 'leave' })} />
              : <Button text="Leave" width={96} height={32} onClick={() => setConfirm('leave')} />
          ) : null}
        </div>
      </div>

      <div className="admin-panel__chips">
        {detail.ranks.map((r) => (
          <span key={r.slug} className="admin-panel__faction-badge">
            {r.name + ' ' + r.count + (r.capacity ? '/' + r.capacity : '')}
          </span>
        ))}
      </div>

      <div className="admin-panel__row admin-panel__row--head">
        <span className="admin-panel__dot" />
        <span className="admin-panel__cell admin-panel__cell--name">Name</span>
        <span className="admin-panel__cell admin-panel__cell--rank">Rank</span>
        <span className="admin-panel__cell admin-panel__cell--status">Actions</span>
      </div>
      <div className="admin-panel__list">
        {detail.members.length === 0 ? (
          <div className="admin-panel__empty">No members yet</div>
        ) : (
          detail.members.map((m) => (
            <div key={m.key} className={'admin-panel__row admin-panel__row--faction' + (m.online ? '' : ' admin-panel__row--offline')}>
              <span className={'admin-panel__dot' + (m.online ? ' admin-panel__dot--online' : '')} />
              <span className="admin-panel__cell admin-panel__cell--name" title={m.slot === null ? 'Every character of this account' : 'Character ' + (m.slot + 1)}>
                {m.name + (m.self ? ' (you)' : '')}
              </span>
              <span className="admin-panel__cell admin-panel__cell--rank">{m.rankName}</span>
              <div className="admin-panel__zone-buttons">
                {m.promote ? <Button text="Promote" width={88} height={24} onClick={() => act(Object.assign({ action: 'promote' }, target(m)))} /> : null}
                {m.demote ? <Button text="Demote" width={84} height={24} onClick={() => act(Object.assign({ action: 'demote' }, target(m)))} /> : null}
                {m.setRanks.length ? (
                  <select
                    className="admin-panel__input admin-panel__faction-rank"
                    value=""
                    onChange={(e) => e.target.value && act(Object.assign({ action: 'setRank', rank: e.target.value }, target(m)))}
                  >
                    <option value="">Set rank</option>
                    {m.setRanks.map((slug) => <option key={slug} value={slug}>{rankName(slug)}</option>)}
                  </select>
                ) : null}
                {m.canUniform && m.online ? <Button text="Uniform" width={84} height={24} onClick={() => act(Object.assign({ action: 'uniform' }, target(m)))} /> : null}
                {m.canRemove ? (
                  confirm === m.key
                    ? <Button text="Confirm" width={84} height={24} onClick={() => act(Object.assign({ action: 'remove' }, target(m)))} />
                    : <Button text="Remove" width={80} height={24} onClick={() => setConfirm(m.key)} />
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      {inviteRanks.length ? (
        <div className="admin-panel__mastery">
          <div className="admin-panel__mastery-row">
            <span className="admin-panel__mastery-who">Invite as</span>
            <select className="admin-panel__input admin-panel__faction-pick" value={pickedRank} onChange={(e) => setInviteRank(e.target.value)}>
              {inviteRanks.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
            </select>
          </div>
          {nearby.length === 0 ? (
            <span className="admin-panel__hint">Nobody is close enough to invite</span>
          ) : (
            nearby.map((p) => (
              <div key={p.target} className="admin-panel__mastery-row">
                <span className="admin-panel__mastery-info">{p.name}</span>
                <Button text="Invite" width={96} height={30} onClick={() => act({ action: 'invite', target: p.target, rank: pickedRank })} />
              </div>
            ))
          )}
        </div>
      ) : null}
      <span className="admin-panel__hint">
        You can also look at a player, press the interact key and choose Invite to faction. Offline members show dimmed.
      </span>
    </div>
  );
};

export default FactionTab;
