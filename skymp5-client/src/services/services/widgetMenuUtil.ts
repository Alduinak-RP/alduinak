import { CombinedController, Sp } from "./clientListener";
import { BrowserService } from "./browserService";
import { FunctionInfo } from "../../lib/functionInfo";
import { ButtonEvent, DxScanCode, InputDeviceType, Menu } from "skyrimPlatform";

// Shared helpers for CEF form-widget menus; widget setters stay per-service (browser-side, injected vars).

// Removes one widget id from the CEF widget list.
export function closeWidget(sp: Sp, widgetId: number): void {
  sp.browser.executeJavaScript(
    '(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==' +
    widgetId + ';});window.skyrimPlatform.widgets.set(ws);})();'
  );
}

// Injects the setter into CEF and gives it focus; a hidden interface comes back first.
export function openFormMenu(sp: Sp, setter: () => void, args: Record<string, unknown>, controller: CombinedController): void {
  showUi(controller);
  sp.browser.executeJavaScript(new FunctionInfo(setter).getText(args));
  sp.browser.setVisible(true);
  sp.browser.setFocused(true);
}

// Data-only re-push for an already open menu; never touches visibility or focus
export function refreshFormMenu(sp: Sp, setter: () => void, args: Record<string, unknown>): void {
  sp.browser.executeJavaScript(new FunctionInfo(setter).getText(args));
}

export function closeFormMenu(sp: Sp, widgetId: number): void {
  closeWidget(sp, widgetId);
  sp.browser.setFocused(false);
}

// A front reload or the login widget reset (authService) drops every widget without a close message
export function onWidgetsCleared(controller: CombinedController, fn: () => void): void {
  controller.emitter.on("browserWindowLoaded", fn);
  controller.emitter.on("createActorMessage", (e) => { if (e.message.isMe) fn(); });
}

// Clears the hide UI toggle before a server-initiated screen is shown.
export function showUi(controller: CombinedController): void {
  try {
    controller.lookupListener(BrowserService).setUiHidden(false);
  } catch {
    // no browser service registered
  }
}

export function isUiHidden(controller: CombinedController): boolean {
  try {
    return controller.lookupListener(BrowserService).isUiHidden();
  } catch {
    return false;
  }
}

// True while chat has focus or a menu that swallows gameplay input is open (console, inventory, map).
export function isGameInputBlocked(sp: Sp, controller: CombinedController): boolean {
  if (sp.browser.isFocused()) return true;
  if (isConsoleOpen(sp)) return true;
  try {
    return controller.lookupListener(BrowserService).isBlockingMenuOpen();
  } catch {
    return false;
  }
}

// Menu hotkeys are also inert while the interface is hidden.
export function isMenuHotkeyBlocked(sp: Sp, controller: CombinedController): boolean {
  return isUiHidden(controller) || isGameInputBlocked(sp, controller);
}

export const CONSOLE_MENUS: string[] = [Menu.Console, Menu.ConsoleNativeUI];

// Live query: the console can swallow input without a tracked menuOpen event
export function isConsoleOpen(sp: Sp): boolean {
  try {
    return CONSOLE_MENUS.some((menu) => sp.Ui.isMenuOpen(menu));
  } catch {
    return false;
  }
}

// Reads the UI language from the skymp5-client settings block.
export function readMenuLanguage(sp: Sp): string {
  try {
    const settings = sp.settings["skymp5-client"] as any;
    const lang = settings && settings["language"];
    return typeof lang === "string" ? lang : "";
  } catch {
    return "";
  }
}

// Reads a DxScanCode key binding from the skymp5-client settings block.
export function readMenuKeyCode(sp: Sp, settingName: string, fallback: number): number {
  return readClientSettingNumber(sp, settingName, fallback);
}

export function readClientSettingNumber(sp: Sp, settingName: string, fallback: number): number {
  try {
    const settings = sp.settings["skymp5-client"] as any;
    if (settings && typeof settings[settingName] === "number") {
      return settings[settingName];
    }
  } catch {
    // fall through to the default
  }
  return fallback;
}

// KeyboardEvent.code by DxScanCode from 1; CEF gets the scan code as is, so extended keys, Num Lock and mouse buttons have none
const DOM_KEY_CODES = ("Escape Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal Backspace Tab " +
  "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Enter ControlLeft " +
  "KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote Backquote ShiftLeft Backslash " +
  "KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash ShiftRight NumpadMultiply AltLeft Space CapsLock " +
  "F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 - ScrollLock Numpad7 Numpad8 Numpad9 NumpadSubtract " +
  "Numpad4 Numpad5 Numpad6 NumpadAdd Numpad1 Numpad2 Numpad3 Numpad0 NumpadDecimal - - - F11 F12").split(" ");

// Lets a focused CEF menu match its own hotkey, since the game sees no keys while the browser has focus
export function domKeyCode(code: number): string {
  const name = DOM_KEY_CODES[code - 1];
  return name && name !== "-" ? name : "";
}

// A button event in the settings' DxScanCode space: keys as is, mouse buttons 256+, gamepad -1 so its bitmasks never alias a key
export function buttonEventKeyCode(e: ButtonEvent): number {
  if (e.device === InputDeviceType.Keyboard) return e.code;
  if (e.device === InputDeviceType.Mouse) return DxScanCode.LeftMouseButton + e.code;
  return -1;
}

// Launcher Settings key names by settings key code (skymp5-launcher renderer.js DIK_LABELS)
const KEY_LABELS: Record<number, string> = {
  2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "0", 12: "-", 13: "=",
  14: "Backspace", 15: "Tab", 16: "Q", 17: "W", 18: "E", 19: "R", 20: "T", 21: "Y", 22: "U", 23: "I",
  24: "O", 25: "P", 26: "[", 27: "]", 28: "Enter", 29: "Left Ctrl", 30: "A", 31: "S", 32: "D", 33: "F",
  34: "G", 35: "H", 36: "J", 37: "K", 38: "L", 39: ";", 40: "'", 41: "Grave (~)", 42: "Left Shift", 43: "\\",
  44: "Z", 45: "X", 46: "C", 47: "V", 48: "B", 49: "N", 50: "M", 51: ",", 52: ".", 53: "/",
  54: "Right Shift", 55: "Numpad *", 56: "Left Alt", 57: "Space", 58: "Caps Lock", 59: "F1", 60: "F2",
  61: "F3", 62: "F4", 63: "F5", 64: "F6", 65: "F7", 66: "F8", 67: "F9", 68: "F10", 69: "Num Lock",
  70: "Scroll Lock", 71: "Numpad 7", 72: "Numpad 8", 73: "Numpad 9", 74: "Numpad -", 75: "Numpad 4",
  76: "Numpad 5", 77: "Numpad 6", 78: "Numpad +", 79: "Numpad 1", 80: "Numpad 2", 81: "Numpad 3",
  82: "Numpad 0", 83: "Numpad .", 87: "F11", 88: "F12", 156: "Numpad Enter", 157: "Right Ctrl",
  181: "Numpad /", 183: "Print Screen", 184: "Right Alt", 197: "Pause", 199: "Home", 200: "Up",
  201: "Page Up", 203: "Left", 205: "Right", 207: "End", 208: "Down", 209: "Page Down", 210: "Insert",
  211: "Delete", 219: "Left Win", 220: "Right Win", 221: "Menu", 256: "Left Mouse", 257: "Right Mouse",
  258: "Middle Mouse", 259: "Mouse 4", 260: "Mouse 5", 261: "Mouse 6", 262: "Mouse 7", 263: "Mouse 8",
};

export function keyLabel(code: number): string {
  return KEY_LABELS[code] || `0x${code.toString(16)}`;
}
