import React, { useEffect } from 'react';
import './ConfirmDialog.scss';
import { loc } from '../../loc';

interface ConfirmDialogProps {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Shaded yes/no dialog over the whole screen; Escape backs out of the dialog, not the menu under it
const ConfirmDialog = ({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: ConfirmDialogProps) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="confirm-dialog">
      <div className="confirm-dialog__box">
        <h3 className="confirm-dialog__title">{title}</h3>
        <p className="confirm-dialog__body">{body}</p>
        <div className="confirm-dialog__actions">
          <button className="confirm-dialog__button" onClick={onConfirm}>{confirmLabel}</button>
          <button className="confirm-dialog__button confirm-dialog__button--cancel" onClick={onCancel}>
            {cancelLabel || loc('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
