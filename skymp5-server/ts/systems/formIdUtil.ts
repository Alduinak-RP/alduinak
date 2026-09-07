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

// First four bytes of an espm record field, little-endian: a plugin-local form id.
export const readFormIdField = (lookup: any, fieldType: string): number => {
  const fields = lookup && lookup.record && Array.isArray(lookup.record.fields) ? lookup.record.fields : [];
  const field = fields.filter((f: any) => f && f.type === fieldType)[0];
  if (!field || !field.data || field.data.length < 4) return 0;
  const b = field.data;
  return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
};

// Global form id stored in a field of a placed espm reference (NAME = base object, XTEL = teleport partner); 0 if absent.
export const espmRefrFieldId = (mp: any, refrId: number, fieldType: string): number => {
  try {
    const refr = mp.lookupEspmRecordById(refrId);
    const local = readFormIdField(refr, fieldType);
    if (local && typeof refr.toGlobalRecordId === "function") {
      return refr.toGlobalRecordId(local) >>> 0;
    }
  } catch { /* not an espm reference */ }
  return 0;
};
