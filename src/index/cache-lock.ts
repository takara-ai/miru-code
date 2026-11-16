import { Database, SQLiteError } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const RETRY_MS = 30;

export async function withIndexCacheLock<T>(path: string, run: () => Promise<T>): Promise<T>;
export async function withIndexCacheLock<T>(
  path: string,
  run: () => Promise<T>,
  wait: false,
): Promise<T | undefined>;
export async function withIndexCacheLock<T>(
  path: string,
  run: () => Promise<T>,
  wait = true,
): Promise<T | undefined> {
  await mkdir(dirname(path), { recursive: true });
  // This zero-byte sidecar is never replaced or removed. SQLite releases its
  // OS lock when a writer exits, including after a crash.
  const lock = new Database(`${path}.lock`);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    while (true) {
      try {
        lock.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
        if (!wait) return undefined;
        await Bun.sleep(RETRY_MS);
      }
    }
    return await run();
  } finally {
    lock.close();
  }
}
