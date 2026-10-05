import * as fs from "fs";
import * as chokidar from "chokidar";
import { after } from "./timers";

const WATCH_DEBOUNCE_MS = 500;

// Temp file plus rename, so an interrupted write cannot truncate the file; throws on failure
export function writeFileAtomic(file: string, text: string): void {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Calls onChange once per save, creation or removal of the file, the burst of events one save produces coalesced into one call
export function watchFileDebounced(file: string, onChange: () => unknown, onError: (e: unknown) => void, ms = WATCH_DEBOUNCE_MS): void {
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = after(ms, () => {
      timer = undefined;
      return onChange();
    });
  };
  const watcher = chokidar.watch(file, { persistent: true, ignoreInitial: true, awaitWriteFinish: true });
  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  watcher.on("error", onError);
}
