// Field checks and time formats shared by the admin panel tabs

export const isNum = (text: string): boolean => text.trim() !== '' && Number.isFinite(Number(text));

export const isBlankOrNum = (text: string): boolean => text.trim() === '' || isNum(text);

export const optionalNumber = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

export const pad2 = (n: number): string => (n < 10 ? '0' : '') + n;

// m:ss, or h:mm:ss past an hour
export const formatCountdown = (totalSec: number): string => {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
};
