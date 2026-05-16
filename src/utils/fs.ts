import fs from 'fs-extra';
import path from 'node:path';

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.ensureDir(dirPath);
}

export async function writeIfNotExists(filePath: string, content: string): Promise<boolean> {
  if (await fs.pathExists(filePath)) {
    return false;
  }
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
  return true;
}

export async function writeAlways(filePath: string, content: string): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function readJsonSafe<T = unknown>(filePath: string): Promise<T | null> {
  try {
    if (!(await fs.pathExists(filePath))) {
      return null;
    }
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  return fs.pathExists(filePath);
}

export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    if (!(await fs.pathExists(filePath))) {
      return null;
    }
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function getLastModified(filePath: string): Promise<Date | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime;
  } catch {
    return null;
  }
}
