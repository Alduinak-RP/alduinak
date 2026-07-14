import type { Sp } from "./clientListener";

// Routes a corner-style notification into the chat's read-only System tab

export const showSystemNotification = (sp: Sp, text: string): void => {
  const t = String(text ?? "");
  if (!t) return;
  try {
    sp.browser.executeJavaScript(
      `window.__alduinakAddSystem && window.__alduinakAddSystem(${JSON.stringify(t)});`
    );
  } catch (e) {
    // ignore
  }
};
