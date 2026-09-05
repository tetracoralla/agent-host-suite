import fs from "node:fs";
import { ObserverError } from "./errors.mjs";
import { requirePrivateWindowsResults, windowsAccessListsSync } from "./windows-private-access.mjs";

export function assertPrivateFiles(requests, code = "STATE_FILE_PERMISSIONS") {
  if (requests.length === 0) return;
  try {
    if (process.platform === "win32") {
      requirePrivateWindowsResults(windowsAccessListsSync(requests));
    } else {
      for (const { path, ensure = false } of requests) {
        let info = fs.lstatSync(path);
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Owner differs");
        if (ensure) { fs.chmodSync(path, info.isDirectory() ? 0o700 : 0o600); info = fs.lstatSync(path); }
        if ((info.mode & 0o077) !== 0) throw new Error("Shared permissions");
      }
    }
  } catch {
    throw new ObserverError(code, "Observer files must be accessible only to the current owner");
  }
}
