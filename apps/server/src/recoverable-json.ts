import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RecoverableJsonResult<T> = {
  value: T | undefined;
  recovered: boolean;
  corrupt: boolean;
};

export async function readRecoverableJson<T>(
  path: string,
  parse: (value: unknown) => T | undefined,
): Promise<RecoverableJsonResult<T>> {
  const primary = await readCandidate(path, parse);
  if (primary.valid) return { value: primary.value, recovered: false, corrupt: false };

  const backup = await readCandidate(`${path}.bak`, parse);
  if (!backup.valid) {
    return {
      value: undefined,
      recovered: false,
      corrupt: primary.exists || backup.exists,
    };
  }

  await restorePrimary(path, backup.value);
  return {
    value: backup.value,
    recovered: true,
    corrupt: primary.exists,
  };
}

export async function writeRecoverableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const backup = `${path}.bak`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, JSON.stringify(value), "utf8");
  await rm(backup, { force: true });
  let backedUp = false;
  try {
    await rename(path, backup);
    backedUp = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    if (backedUp) await rename(backup, path).catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readCandidate<T>(
  path: string,
  parse: (value: unknown) => T | undefined,
): Promise<{ exists: true; valid: true; value: T } | { exists: boolean; valid: false }> {
  try {
    const value = parse(JSON.parse(await readFile(path, "utf8")));
    return value === undefined
      ? { exists: true, valid: false }
      : { exists: true, valid: true, value };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { exists: false, valid: false }
      : { exists: true, valid: false };
  }
}

async function restorePrimary(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.recover.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, JSON.stringify(value), "utf8");
  await rm(path, { force: true });
  await rename(temporary, path);
}
