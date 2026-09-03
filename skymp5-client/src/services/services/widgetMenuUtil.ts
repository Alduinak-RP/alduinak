import { CombinedController, Sp } from "./clientListener";
import { BrowserService } from "./browserService";
import { FunctionInfo } from "../../lib/functionInfo";
import { Menu } from "skyrimPlatform";

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

export function closeFormMenu(sp: Sp, widgetId: number): void {
  closeWidget(sp, widgetId);
  sp.browser.setFocused(false);
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

// Live query: the console can swallow input without a tracked menuOpen event
export function isConsoleOpen(sp: Sp): boolean {
  try {
    return sp.Ui.isMenuOpen(Menu.Console) || sp.Ui.isMenuOpen(Menu.ConsoleNativeUI);
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
