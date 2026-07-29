// Coerce a client-supplied or settings value to a uint32 form id.
export const toFormId = (v: unknown, fallback = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v >>> 0;
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) {
      return n >>> 0;
    }
  }
  return fallback;
};
