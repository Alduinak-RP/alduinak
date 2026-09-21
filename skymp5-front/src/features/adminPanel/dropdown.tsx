import React, { useEffect, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

interface ListPos {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
}

const LIST_MAX_HEIGHT = 300;

// In-game CEF never paints a native <select> popup, so every picker in the panel draws its own list
const Dropdown = ({ value, options, onChange, disabled, placeholder, className }: DropdownProps) => {
  const [pos, setPos] = useState<ListPos | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return undefined;
    const close = () => setPos(null);
    const closeOutside = (e: Event) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) close();
    };
    window.addEventListener('mousedown', closeOutside);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', closeOutside);
    return () => {
      window.removeEventListener('mousedown', closeOutside);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', closeOutside);
    };
  }, [pos]);

  const toggle = (): void => {
    if (pos || disabled || !button.current) return setPos(null);
    const r = button.current.getBoundingClientRect();
    // Opens upward when the space below the button is too short
    const below = window.innerHeight - r.bottom;
    setPos(below >= Math.min(LIST_MAX_HEIGHT, options.length * 34) || below >= r.top
      ? { left: r.left, width: r.width, top: r.bottom }
      : { left: r.left, width: r.width, bottom: window.innerHeight - r.top });
  };

  const selected = options.find((o) => o.value === value);
  return (
    <>
      <button
        type="button"
        ref={button}
        className={'admin-panel__input admin-panel__dropdown' + (className ? ' ' + className : '')}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="admin-panel__dropdown-label">{selected ? selected.label : placeholder || ''}</span>
        <span className={'admin-panel__dropdown-caret' + (pos ? ' admin-panel__dropdown-caret--open' : '')} />
      </button>
      {pos ? (
        <div
          ref={list}
          className="admin-panel__menu admin-panel__menu--list"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width }}
        >
          {options.length ? options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={'admin-panel__menu-item' + (o.value === value ? ' admin-panel__menu-item--active' : '')}
              onClick={() => {
                setPos(null);
                if (o.value !== value) onChange(o.value);
              }}
            >
              {o.label}
            </button>
          )) : <span className="admin-panel__menu-empty">Nothing to choose</span>}
        </div>
      ) : null}
    </>
  );
};

export default Dropdown;
