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

// Every form id in the fields of one type (KWDA, LNAM...), mapped to global ids.
export const espmFieldFormIds = (lookup: any, fieldType: string): number[] => {
  const out: number[] = [];
  if (!lookup || !lookup.record || typeof lookup.toGlobalRecordId !== "function") return out;
  for (const f of lookup.record.fields || []) {
    if (f.type !== fieldType || !(f.data instanceof Uint8Array)) continue;
    const view = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    for (let off = 0; off + 4 <= f.data.byteLength; off += 4) {
      try { out.push(lookup.toGlobalRecordId(view.getUint32(off, true)) >>> 0); } catch { /* unmapped master */ }
    }
  }
  return out;
};

// Default (keywordless) linked reference of a placed espm reference; 0 if absent.
export const espmLinkedRefId = (lookup: any): number => {
  if (!lookup || !lookup.record || typeof lookup.toGlobalRecordId !== "function") return 0;
  for (const f of lookup.record.fields || []) {
    if (f.type !== "XLKR" || !(f.data instanceof Uint8Array) || f.data.byteLength < 8) continue;
    const view = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    if (view.getUint32(0, true) !== 0) continue;
    try { return lookup.toGlobalRecordId(view.getUint32(4, true)) >>> 0; } catch { return 0; }
  }
  return 0;
};

// Papyrus scripts on a record (VMAD): lower-case script name -> lower-case property -> value; objects are global form ids.
export const readVmadScripts = (lookup: any): Map<string, Record<string, number>> => {
  const out = new Map<string, Record<string, number>>();
  const fields = lookup && lookup.record && Array.isArray(lookup.record.fields) ? lookup.record.fields : [];
  const f = fields.filter((x: any) => x && x.type === "VMAD" && x.data instanceof Uint8Array)[0];
  if (!f || typeof lookup.toGlobalRecordId !== "function") return out;
  const view = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
  let off = 0;
  const u8 = () => view.getUint8(off++);
  const u16 = () => { const v = view.getUint16(off, true); off += 2; return v; };
  const u32 = () => { const v = view.getUint32(off, true); off += 4; return v; };
  const str = () => { const n = u16(); const s = String.fromCharCode(...f.data.subarray(off, off + n)); off += n; return s; };
  const obj = (format: number) => {
    const id = format === 1 ? view.getUint32(off, true) : view.getUint32(off + 4, true);
    off += 8;
    try { return lookup.toGlobalRecordId(id) >>> 0; } catch { return 0; }
  };
  try {
    const version = u16();
    const format = u16();
    const scriptCount = u16();
    for (let s = 0; s < scriptCount; s++) {
      const name = str().toLowerCase();
      if (version >= 4) u8();
      const props: Record<string, number> = {};
      const propCount = u16();
      for (let p = 0; p < propCount; p++) {
        const prop = str().toLowerCase();
        const type = u8();
        if (version >= 4) u8();
        if (type === 1) props[prop] = obj(format);
        else if (type === 2) str();
        else if (type === 3) props[prop] = view.getInt32((off += 4) - 4, true);
        else if (type === 4) props[prop] = view.getFloat32((off += 4) - 4, true);
        else if (type === 5) props[prop] = u8();
        else if (type >= 11 && type <= 15) {
          const n = u32();
          for (let i = 0; i < n; i++) {
            if (type === 11) off += 8;
            else if (type === 12) str();
            else off += type === 15 ? 1 : 4;
          }
        } else {
          out.set(name, props);
          return out;
        }
      }
      out.set(name, props);
    }
  } catch { /* truncated VMAD: keep what parsed */ }
  return out;
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
