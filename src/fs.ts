import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode).catch(() => undefined);
}

export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await ensureDir(dirname(path));
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);

  try {
    await writeFile(temp, content, { mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// The owner's PID is written to a private file that is then hard-linked into
// place, so a lock file never exists without its owner. Creating the lock file
// first and writing the PID afterwards let a concurrent caller read an empty
// file, judge it stale, and take a lock that was still held.
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  await ensureDir(dirname(path));
  const claim = join(dirname(path), `.${randomUUID()}.lock-claim`);
  await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: "wx" });

  try {
    try {
      await link(claim, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const pid = Number((await readText(path))?.trim());
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive)
        try {
          process.kill(pid, 0);
        } catch (check) {
          if ((check as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }

      if (alive) throw error;
      await rm(path, { force: true });
      await link(claim, path);
    }
  } finally {
    await rm(claim, { force: true });
  }

  return async () => {
    await rm(path, { force: true });
  };
}
