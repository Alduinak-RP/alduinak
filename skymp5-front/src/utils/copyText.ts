// A selected textarea copies inside the click; CEF may refuse the async clipboard API, so that is only the fallback
export const copyText = (text: string): Promise<boolean> => {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;user-select:text;';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (e) {
    copied = false;
  }
  document.body.removeChild(area);
  if (copied || !navigator.clipboard) return Promise.resolve(copied);
  return navigator.clipboard.writeText(text).then(() => true, () => false);
};
