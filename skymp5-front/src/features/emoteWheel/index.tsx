import React, { useEffect, useRef, useState } from 'react';

import { assetUrl } from '../../utils/assetUrl';

import './styles.scss';

interface EmoteDef {
  anim: string;
  label: string;
  // Set by the client when the emote needs an item the character does not carry
  locked?: boolean;
  needs?: string;
}

interface EmoteGroup {
  id: string;
  label: string;
  emotes: EmoteDef[];
}

interface EmoteWheelEvents {
  play: string;
  close: string;
  stop: string;
  key: string;
  keyUp: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface EmoteWheelData {
  groups: EmoteGroup[];
  events: EmoteWheelEvents;
  hold?: boolean;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('emoteWheel sendMessage', key, args);
  }
};

// Wheel geometry ported from Vengeful Realms' emote wheel, used with permission.
const CENTER = 410;
const CATEGORY_INNER = 155;
const CATEGORY_OUTER = 238;
const EMOTE_INNER = 252;
const EMOTE_OUTER = 390;
const GAP_DEG = 1.1;

const polarToCartesian = (cx: number, cy: number, radius: number, angleDeg: number) => {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
};

const describeArcSegment = (cx: number, cy: number, innerR: number, outerR: number, startAngle: number, endAngle: number): string => {
  const outerStart = polarToCartesian(cx, cy, outerR, endAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, endAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return [
    'M', outerStart.x, outerStart.y,
    'A', outerR, outerR, 0, largeArc, 0, outerEnd.x, outerEnd.y,
    'L', innerStart.x, innerStart.y,
    'A', innerR, innerR, 0, largeArc, 1, innerEnd.x, innerEnd.y,
    'Z',
  ].join(' ');
};

const shortenLabel = (label: string): string => {
  if (label.length <= 15) return label;
  return label
    .replace(' Hands ', ' H. ')
    .replace('Attention', 'Attn')
    .replace('Crossed', 'Cross')
    .replace('Sitting', 'Sit');
};

const previewFor = (anim: string): string => {
  try {
    return assetUrl(require('./assets/' + anim + '.gif'));
  } catch (e) {
    return assetUrl(require('./assets/portrait-template.png'));
  }
};

// An Image outside the document never advances, so this paints the gif's first frame
const StillFrame = ({ src }: { src: string }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
    };
    img.src = src;
    return () => {
      img.onload = null;
      img.src = '';
    };
  }, [src]);
  return <canvas ref={canvasRef} aria-label="Selected emote preview" />;
};

interface RingProps {
  innerR: number;
  outerR: number;
  segClass: string;
  labelClass: string;
  activeId: string;
  items: { id: string; label: string; locked?: boolean }[];
  onHover?: (id: string) => void;
  onLeave?: () => void;
  onClick: (id: string) => void;
}

const Ring = ({ innerR, outerR, segClass, labelClass, activeId, items, onHover, onLeave, onClick }: RingProps) => {
  const step = 360 / items.length;
  const startOffset = -90;
  const labelR = innerR + (outerR - innerR) * 0.55;
  return (
    <>
      {items.map((item, index) => {
        const startAngle = startOffset + index * step + GAP_DEG;
        const endAngle = startOffset + (index + 1) * step - GAP_DEG;
        const labelPoint = polarToCartesian(CENTER, CENTER, labelR, (startAngle + endAngle) / 2);
        return (
          <g key={item.id}>
            <path
              d={describeArcSegment(CENTER, CENTER, innerR, outerR, startAngle, endAngle)}
              className={segClass + (item.id === activeId ? ' active' : '') + (item.locked ? ' locked' : '')}
              onMouseEnter={onHover ? () => onHover(item.id) : undefined}
              onMouseLeave={onLeave}
              onClick={() => onClick(item.id)}
            />
            <text x={labelPoint.x} y={labelPoint.y} className={labelClass + (item.locked ? ' locked' : '')}>
              {shortenLabel(item.label)}
            </text>
          </g>
        );
      })}
    </>
  );
};

// Selection survives close/reopen; the client tears the widget down each time.
let savedGroupId = '';
let savedAnim = '';

const EmoteWheel = ({ data }: { data: EmoteWheelData }) => {
  const groups = data.groups || [];
  const ev = data.events || ({} as EmoteWheelEvents);

  const firstGroup = groups[0];
  const firstAnim = firstGroup && firstGroup.emotes[0] ? firstGroup.emotes[0].anim : '';
  const savedGroup = groups.find((g) => g.id === savedGroupId && g.emotes.some((e) => e.anim === savedAnim));
  const initialGroup = savedGroup || firstGroup;
  const initialAnim = savedGroup ? savedAnim : firstAnim;
  const [activeGroupId, setActiveGroupId] = useState(initialGroup ? initialGroup.id : '');
  const [activeAnim, setActiveAnim] = useState(initialAnim);
  const [previewAnim, setPreviewAnim] = useState(initialAnim);
  const [previewSrc, setPreviewSrc] = useState(() => previewFor(initialAnim));
  const [previewChanging, setPreviewChanging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [refusedAnim, setRefusedAnim] = useState('');
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The emote slice under the cursor, played when a held wheel key is released
  const hoveredRef = useRef('');

  useEffect(() => {
    // Losing browser focus (free-cursor key, chat) would strand the overlay.
    const onUnfocused = () => send(ev.close);
    // The game sees no keys while the wheel has focus, so the client matches presses and releases to the wheel key
    const onKeyDown = (e: KeyboardEvent) => { if (!e.repeat) send(ev.key, e.code); };
    const onKeyUp = (e: KeyboardEvent) => {
      const anim = hoveredRef.current;
      const group = anim && data.hold ? groups.find((g) => g.emotes.some((it) => it.anim === anim)) : undefined;
      if (group) {
        savedGroupId = group.id;
        savedAnim = anim;
      }
      send(ev.keyUp, e.code, anim);
    };
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (swapTimer.current) clearTimeout(swapTimer.current);
    };
  }, []);

  const activeGroup = groups.find((g) => g.id === activeGroupId) || firstGroup;
  const previewedGroup = groups.find((g) => g.emotes.some((it) => it.anim === previewAnim)) || activeGroup;
  const previewedEmote =
    (previewedGroup && previewedGroup.emotes.find((it) => it.anim === previewAnim)) ||
    (activeGroup && activeGroup.emotes[0]);
  const previewLocked = !!(previewedEmote && previewedEmote.locked);
  const refused = previewLocked && previewedEmote && previewedEmote.anim === refusedAnim ? previewedEmote : null;

  // Short dip while the preview gif swaps, so the change reads as intentional.
  const changePreview = (anim: string) => {
    setPreviewAnim(anim);
    const next = previewFor(anim);
    setPreviewChanging(true);
    if (swapTimer.current) clearTimeout(swapTimer.current);
    swapTimer.current = setTimeout(() => {
      setPreviewSrc(next);
      setPreviewChanging(false);
    }, 120);
  };

  const selectGroup = (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group || !group.emotes.length) return;
    savedGroupId = groupId;
    savedAnim = group.emotes[0].anim;
    setActiveGroupId(groupId);
    setActiveAnim(group.emotes[0].anim);
    changePreview(group.emotes[0].anim);
  };

  const selectEmote = (anim: string) => {
    savedGroupId = activeGroupId;
    savedAnim = anim;
    setActiveAnim(anim);
    changePreview(anim);
    const emote = activeGroup && activeGroup.emotes.find((e) => e.anim === anim);
    if (emote && emote.locked) {
      setRefusedAnim(anim);
      return;
    }
    send(ev.play, anim);
  };

  if (!activeGroup) return null;

  return (
    <div
      className="emote-wheel"
      onContextMenu={(e) => {
        e.preventDefault();
        send(ev.close);
      }}
    >
      <div className="emote-wheel__fade" />
      <div className="emote-wheel__stage">
        <section className="emote-wheel__wheel-section">
          <div className="emote-wheel__wheel-wrap">
            <svg className="emote-wheel__svg" viewBox="0 0 820 820" role="img" aria-label="Radial emote selector">
              <Ring
                innerR={CATEGORY_INNER}
                outerR={CATEGORY_OUTER}
                segClass="emote-wheel__category-segment"
                labelClass="emote-wheel__segment-label-small"
                activeId={activeGroup.id}
                items={groups.map((g) => ({ id: g.id, label: g.label }))}
                onClick={selectGroup}
              />
              <Ring
                innerR={EMOTE_INNER}
                outerR={EMOTE_OUTER}
                segClass="emote-wheel__emote-segment"
                labelClass="emote-wheel__segment-label"
                activeId={activeAnim}
                items={activeGroup.emotes.map((e) => ({ id: e.anim, label: e.label, locked: e.locked }))}
                onHover={(anim) => { hoveredRef.current = anim; setHovering(true); changePreview(anim); }}
                onLeave={() => { hoveredRef.current = ''; setHovering(false); }}
                onClick={selectEmote}
              />
            </svg>
            <div className="emote-wheel__center">
              <p className={'emote-wheel__center-category' + (refused ? ' emote-wheel__center-category--needs' : '')}>
                {(refused ? 'Needs ' + refused.needs : previewedGroup ? previewedGroup.label : '').toUpperCase()}
              </p>
              <h2 className="emote-wheel__center-emote">{previewedEmote ? previewedEmote.label : ''}</h2>
              <button className="emote-wheel__center-cancel" onClick={() => send(ev.stop)}>
                Cancel Emote
              </button>
            </div>
          </div>
          <p className="emote-wheel__hint">Hover to preview&nbsp;&nbsp;&bull;&nbsp;&nbsp;Click to play&nbsp;&nbsp;&bull;&nbsp;&nbsp;Esc or right-click to close</p>
        </section>
        <aside className="emote-wheel__preview">
          <h2 className="emote-wheel__preview-name">{previewedEmote ? previewedEmote.label : ''}</h2>
          <div
            className={
              'emote-wheel__preview-frame' +
              (previewChanging ? ' emote-wheel__preview-frame--changing' : '') +
              (previewLocked ? ' emote-wheel__preview-frame--locked' : '')
            }
          >
            <div className="emote-wheel__preview-glow" />
            {previewLocked && previewedEmote && <p className="emote-wheel__preview-needs">Requires {previewedEmote.needs}</p>}
            {hovering ? <img src={previewSrc} alt="Selected emote preview" /> : <StillFrame src={previewSrc} />}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default EmoteWheel;
