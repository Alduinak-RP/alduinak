import React, { useEffect, useState } from 'react';

import Button from '../../constructorComponents/button';
import { isBlankOrNum, isNum, optionalNumber } from './util';
import { loc } from '../../loc';

interface JobEnd {
  id: string;
  pos: number[];
  radius: number;
  label: string;
}

// One Jobs.json entry as listed by the server (jobSystem.ts JobSummary)
export interface JobRow {
  name: string;
  enabled: boolean;
  status: string; // "" while the job runs, else "disabled" and/or why it does not
  item: string;
  prompt: string;
  pay: number;
  anim: string;
  requires: string[];
  requiresText: string;
  pickup: JobEnd;
  dropoff: JobEnd;
  carrying: number; // players on a trip for it right now
}

// The adminPos reply; end is the job end a Set here press asked for
export interface AdminPos {
  id: string;
  pos: number[];
  at: number;
  end?: string;
}

interface JobsProps {
  jobs: JobRow[] | null;
  pos: AdminPos | null;
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
}

// Blank Item, Prompt, Pay, Carry anim, radius and label take the server defaults
const EMPTY_JOB_FORM = {
  name: '',
  item: '',
  prompt: '',
  pay: '',
  anim: '',
  requires: '',
  requiresText: '',
  enabled: true,
  pickupId: '',
  pickupPos: '',
  pickupRadius: '200',
  pickupLabel: '',
  dropoffId: '',
  dropoffPos: '',
  dropoffRadius: '250',
  dropoffLabel: '',
};
type JobForm = typeof EMPTY_JOB_FORM;
type JobTextField = Exclude<keyof JobForm, 'enabled'>;

// Four columns: the job, what it asks for, then one row per end
const JOB_FIELDS: Array<{ key: JobTextField; label: string; placeholder: string; half?: boolean }> = [
  { key: 'name', label: loc('adminPanel.common.name'), placeholder: loc('adminPanel.jobs.namePlaceholder'), half: true },
  { key: 'item', label: loc('adminPanel.jobs.item'), placeholder: loc('adminPanel.jobs.itemPlaceholder') },
  { key: 'prompt', label: loc('adminPanel.jobs.prompt'), placeholder: loc('adminPanel.jobs.promptPlaceholder') },
  { key: 'pay', label: loc('adminPanel.jobs.pay'), placeholder: loc('adminPanel.jobs.payPlaceholder') },
  { key: 'anim', label: loc('adminPanel.jobs.anim'), placeholder: 'OffsetCarryBasketStart' },
  { key: 'requires', label: loc('adminPanel.jobs.requires'), placeholder: 'woodChoppingAxes' },
  { key: 'requiresText', label: loc('adminPanel.jobs.requiresText'), placeholder: loc('adminPanel.jobs.requiresTextPlaceholder') },
  { key: 'pickupId', label: loc('adminPanel.jobs.pickupId'), placeholder: loc('adminPanel.jobs.setPickup') },
  { key: 'pickupPos', label: loc('adminPanel.jobs.pickupPos'), placeholder: loc('adminPanel.jobs.posPlaceholder') },
  { key: 'pickupRadius', label: loc('adminPanel.jobs.pickupRadius'), placeholder: '200' },
  { key: 'pickupLabel', label: loc('adminPanel.jobs.pickupLabel'), placeholder: loc('adminPanel.jobs.pickupLabelPlaceholder') },
  { key: 'dropoffId', label: loc('adminPanel.jobs.dropoffId'), placeholder: loc('adminPanel.jobs.setDropoff') },
  { key: 'dropoffPos', label: loc('adminPanel.jobs.dropoffPos'), placeholder: loc('adminPanel.jobs.posPlaceholder') },
  { key: 'dropoffRadius', label: loc('adminPanel.jobs.dropoffRadius'), placeholder: '250' },
  { key: 'dropoffLabel', label: loc('adminPanel.jobs.dropoffLabel'), placeholder: loc('adminPanel.jobs.dropoffLabelPlaceholder') },
];

// Closing the menu to walk to the other end remounts the panel, so the form and the last applied position live here
let savedForm: JobForm = EMPTY_JOB_FORM;
let appliedPosAt = 0;

const optionalText = (text: string): string | undefined => text.trim() || undefined;

const isPos = (text: string): boolean => {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  return parts.length === 3 && parts.every(isNum);
};

const posText = (pos: number[]): string => (pos && pos.length === 3 ? pos.join(', ') : '');

const formOf = (j: JobRow): JobForm => ({
  name: j.name,
  item: j.item,
  prompt: j.prompt,
  pay: String(j.pay),
  anim: j.anim,
  requires: (j.requires || []).join(', '),
  requiresText: j.requires && j.requires.length ? j.requiresText : '',
  enabled: j.enabled,
  pickupId: j.pickup.id,
  pickupPos: posText(j.pickup.pos),
  pickupRadius: String(j.pickup.radius),
  pickupLabel: j.pickup.label,
  dropoffId: j.dropoff.id,
  dropoffPos: posText(j.dropoff.pos),
  dropoffRadius: String(j.dropoff.radius),
  dropoffLabel: j.dropoff.label,
});

const statusText = (j: JobRow): string => {
  if (j.status) return j.status.charAt(0).toUpperCase() + j.status.slice(1);
  return loc(j.carrying ? 'adminPanel.jobs.activeCarrying' : 'adminPanel.jobs.active', { item: j.item, pay: j.pay, n: j.carrying });
};

const Jobs = ({ jobs, pos, ev, send }: JobsProps) => {
  const [form, setFormState] = useState<JobForm>(savedForm);

  const setForm = (next: JobForm): void => {
    savedForm = next;
    setFormState(next);
  };

  // Set here: the server's answer fills that end's ID and POS once
  const posAt = pos ? pos.at : 0;
  useEffect(() => {
    if (!pos || pos.at === appliedPosAt || (pos.end !== 'pickup' && pos.end !== 'dropoff') || !pos.id || !pos.pos || pos.pos.length !== 3) return;
    appliedPosAt = pos.at;
    setForm(pos.end === 'pickup'
      ? { ...savedForm, pickupId: pos.id, pickupPos: posText(pos.pos) }
      : { ...savedForm, dropoffId: pos.id, dropoffPos: posText(pos.pos) });
  }, [posAt]);

  const canSave = !!(form.name.trim() && form.pickupId.trim() && form.dropoffId.trim())
    && isPos(form.pickupPos) && isPos(form.dropoffPos)
    && isBlankOrNum(form.pay) && isBlankOrNum(form.pickupRadius) && isBlankOrNum(form.dropoffRadius);

  const save = (): void => {
    if (!canSave) return;
    send(ev.jobSave, JSON.stringify({
      Name: form.name.trim(),
      Enabled: form.enabled,
      Item: optionalText(form.item),
      Prompt: optionalText(form.prompt),
      Pay: optionalNumber(form.pay),
      CarryAnim: optionalText(form.anim),
      Requires: form.requires.split(',').map((s) => s.trim()).filter(Boolean),
      RequiresText: optionalText(form.requiresText),
      Pickup: { ID: form.pickupId.trim(), POS: form.pickupPos.trim(), Radius: optionalNumber(form.pickupRadius), Label: optionalText(form.pickupLabel) },
      Dropoff: { ID: form.dropoffId.trim(), POS: form.dropoffPos.trim(), Radius: optionalNumber(form.dropoffRadius), Label: optionalText(form.dropoffLabel) },
    }));
  };

  const list = jobs || [];

  return (
    <div className="admin-panel__body">
      <div className="admin-panel__list admin-panel__list--jobs">
        {!jobs ? (
          <div className="admin-panel__empty">{loc('adminPanel.jobs.loading')}</div>
        ) : list.length === 0 ? (
          <div className="admin-panel__empty">{loc('adminPanel.jobs.none')}</div>
        ) : (
          list.map((j) => (
            <div key={j.name} className="admin-panel__row admin-panel__row--zone">
              <div className="admin-panel__zone-info">
                <span className="admin-panel__cell admin-panel__cell--name">{j.name}</span>
                <span className="admin-panel__cell admin-panel__cell--status" title={j.status}>
                  <span className={'admin-panel__dot' + (j.status ? '' : ' admin-panel__dot--online')} />
                  {statusText(j)}
                </span>
              </div>
              <div className="admin-panel__zone-buttons">
                <Button text={loc('adminPanel.jobs.tpPickup')} width={96} height={24} onClick={() => send(ev.jobTp, j.name, 'pickup')} />
                <Button text={loc('adminPanel.jobs.tpDropoff')} width={104} height={24} onClick={() => send(ev.jobTp, j.name, 'dropoff')} />
                <Button text={loc('adminPanel.common.edit')} width={56} height={24} onClick={() => setForm(formOf(j))} />
                <Button text={loc('adminPanel.common.delete')} width={68} height={24} onClick={() => send(ev.jobDelete, j.name)} />
              </div>
            </div>
          ))
        )}
      </div>
      <div className="admin-panel__form">
        {JOB_FIELDS.map((f) => (
          <label key={f.key} className={'admin-panel__field' + (f.half ? ' admin-panel__field--half' : '')}>
            {f.label}
            <input
              className="admin-panel__input"
              placeholder={f.placeholder}
              value={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="admin-panel__actions">
        <Button text={loc('adminPanel.jobs.setPickup')} width={168} height={32} onClick={() => send(ev.jobPos, 'pickup')} />
        <Button text={loc('adminPanel.jobs.setDropoff')} width={168} height={32} onClick={() => send(ev.jobPos, 'dropoff')} />
        <label className="admin-panel__checkbox">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {loc('adminPanel.jobs.enabled')}
        </label>
        <Button text={loc('common.save')} width={104} height={32} disabled={!canSave} onClick={save} />
        <Button text={loc('adminPanel.common.clear')} width={104} height={32} onClick={() => setForm(EMPTY_JOB_FORM)} />
      </div>
      <span className="admin-panel__hint">
        {loc('adminPanel.jobs.hint')}
      </span>
    </div>
  );
};

export default Jobs;
