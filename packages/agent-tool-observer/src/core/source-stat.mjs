import fs from 'node:fs';
import { ObserverError } from '../errors.mjs';

// Node 22.16 on Windows can return dev=0 for a path stat and the actual
// volume serial for fstat. Persist and compare the descriptor identity on
// both discovery and read; dropping the volume would conflate different disks.
export function statSourcePath(filePath) {
  const named = fs.lstatSync(filePath);
  if (process.platform !== 'win32' || !named.isFile() || named.isSymbolicLink()) return named;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath);
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
        || named.ino !== opened.ino || current.ino !== opened.ino) {
      throw new ObserverError('SOURCE_FILE_REPLACED', 'Provider source changed during discovery');
    }
    return opened;
  } finally {
    fs.closeSync(descriptor);
  }
}
