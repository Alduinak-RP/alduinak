// KeyboardEvent.code -> [DirectInput scan code, label], the launcher's KEY_TABLE (skymp5-launcher renderer.js) copied because the front cannot import it; DIK codes match DxScanCode in the client
export const DOM_TO_DIK: Record<string, [number, string]> = {
  Enter: [28, 'Enter'], Space: [57, 'Space'], Tab: [15, 'Tab'],
  ShiftLeft: [42, 'Left Shift'], ControlLeft: [29, 'Left Ctrl'], AltLeft: [56, 'Left Alt'],
  ShiftRight: [54, 'Right Shift'], ControlRight: [157, 'Right Ctrl'], AltRight: [184, 'Right Alt'],
  CapsLock: [58, 'Caps Lock'], Backquote: [41, 'Grave (~)'], Backspace: [14, 'Backspace'],
  KeyA: [30, 'A'], KeyB: [48, 'B'], KeyC: [46, 'C'], KeyD: [32, 'D'],
  KeyE: [18, 'E'], KeyF: [33, 'F'], KeyG: [34, 'G'], KeyH: [35, 'H'],
  KeyI: [23, 'I'], KeyJ: [36, 'J'], KeyK: [37, 'K'], KeyL: [38, 'L'],
  KeyM: [50, 'M'], KeyN: [49, 'N'], KeyO: [24, 'O'], KeyP: [25, 'P'],
  KeyQ: [16, 'Q'], KeyR: [19, 'R'], KeyS: [31, 'S'], KeyT: [20, 'T'],
  KeyU: [22, 'U'], KeyV: [47, 'V'], KeyW: [17, 'W'], KeyX: [45, 'X'],
  KeyY: [21, 'Y'], KeyZ: [44, 'Z'],
  Digit1: [2, '1'], Digit2: [3, '2'], Digit3: [4, '3'], Digit4: [5, '4'], Digit5: [6, '5'],
  Digit6: [7, '6'], Digit7: [8, '7'], Digit8: [9, '8'], Digit9: [10, '9'], Digit0: [11, '0'],
  Minus: [12, '-'], Equal: [13, '='],
  BracketLeft: [26, '['], BracketRight: [27, ']'],
  Semicolon: [39, ';'], Quote: [40, "'"], Backslash: [43, '\\'],
  Comma: [51, ','], Period: [52, '.'], Slash: [53, '/'],
  F1: [59, 'F1'], F2: [60, 'F2'], F3: [61, 'F3'], F4: [62, 'F4'],
  F5: [63, 'F5'], F6: [64, 'F6'], F7: [65, 'F7'], F8: [66, 'F8'],
  F9: [67, 'F9'], F10: [68, 'F10'], F11: [87, 'F11'], F12: [88, 'F12'],
  Numpad0: [82, 'Numpad 0'], Numpad1: [79, 'Numpad 1'], Numpad2: [80, 'Numpad 2'],
  Numpad3: [81, 'Numpad 3'], Numpad4: [75, 'Numpad 4'], Numpad5: [76, 'Numpad 5'],
  Numpad6: [77, 'Numpad 6'], Numpad7: [71, 'Numpad 7'], Numpad8: [72, 'Numpad 8'],
  Numpad9: [73, 'Numpad 9'],
  NumpadMultiply: [55, 'Numpad *'], NumpadSubtract: [74, 'Numpad -'], NumpadAdd: [78, 'Numpad +'],
  NumpadDecimal: [83, 'Numpad .'], NumpadDivide: [181, 'Numpad /'], NumpadEnter: [156, 'Numpad Enter'],
  NumLock: [69, 'Num Lock'], ScrollLock: [70, 'Scroll Lock'], Pause: [197, 'Pause'], PrintScreen: [183, 'Print Screen'],
  ArrowUp: [200, 'Up'], ArrowDown: [208, 'Down'], ArrowLeft: [203, 'Left'], ArrowRight: [205, 'Right'],
  PageUp: [201, 'Page Up'], PageDown: [209, 'Page Down'],
  Insert: [210, 'Insert'], Delete: [211, 'Delete'], Home: [199, 'Home'], End: [207, 'End'],
  MetaLeft: [219, 'Left Win'], MetaRight: [220, 'Right Win'], ContextMenu: [221, 'Menu'],
};

// MouseEvent.button -> [DxScanCode, label]; left and right stay attack and block, so they cancel a capture
export const MOUSE_TO_DIK: Record<number, [number, string]> = { 1: [258, 'Middle Mouse'], 3: [259, 'Mouse 4'], 4: [260, 'Mouse 5'] };

const DIK_LABELS: Record<number, string> = { 256: 'Left Mouse', 257: 'Right Mouse', 261: 'Mouse 6', 262: 'Mouse 7', 263: 'Mouse 8' };
for (const [dik, label] of [...Object.values(DOM_TO_DIK), ...Object.values(MOUSE_TO_DIK)]) DIK_LABELS[dik] = label;

export const dikLabel = (code: number): string => DIK_LABELS[code] || `0x${code.toString(16)}`;

// The client polls a held menu key in game, so any bound key or mouse button can be held
export const canHold = (code: number): boolean => code > 0;
