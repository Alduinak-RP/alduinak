import * as fs from "fs";

// Temp file plus rename, so an interrupted write cannot truncate the file; throws on failure
export function writeFileAtomic(file: string, text: string): void {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
