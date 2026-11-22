import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CliError, cliError } from '../errors/cli-error';
import { ExitCode } from '../errors/exit-codes';
import type { Localized } from '../i18n';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export type WarningSink = (message: Localized) => void;
const noWarnings: WarningSink = () => undefined;

const IS_POSIX = process.platform !== 'win32';

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function insecure(target: string, reason: string): CliError {
  return cliError('INSECURE_PATH', { path: target }, { details: { reason } });
}

/** Owned by root: almost always an earlier `sudo hb …`; say how to fix it (same code, exit 1). */
function ownedByRoot(target: string): CliError {
  return new CliError({
    code: 'INSECURE_PATH',
    exitCode: ExitCode.GENERAL,
    message: {
      tr: `${target} root kullanıcısına ait (büyük olasılıkla daha önce sudo ile çalıştırıldı); kullanılmadı. Düzeltmek için: sudo chown -R "$(id -un)" "${target}"`,
      en: `${target} is owned by root (probably from an earlier sudo run); not used. To fix: sudo chown -R "$(id -un)" "${target}"`,
    },
    details: { reason: 'owner' },
  });
}

function ownerError(target: string, ownerUid: number): CliError {
  return ownerUid === 0 ? ownedByRoot(target) : insecure(target, 'owner');
}

/**
 * ssh StrictModes-like check of our config directory (POSIX only; Windows relies on the per-user profile ACL).
 * The directory may be a symlink (dotfiles setups) but its target must be a directory owned by the current user.
 * If it is ours but writable by group/others it is tightened to 0700 with a warning; owned by someone else is
 * refused (INSECURE_PATH, exit 1), because whoever can write there can redirect `apiUrl` or swap the key.
 * Returns false when the directory does not exist.
 */
export async function ensurePrivateDir(dir: string, onWarning: WarningSink = noWarnings): Promise<boolean> {
  if (!IS_POSIX) return true;
  let info;
  try {
    info = await stat(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory()) throw insecure(dir, 'not-a-directory');
  const uid = currentUid();
  if (uid !== undefined && info.uid !== uid) throw ownerError(dir, info.uid);
  if ((info.mode & 0o022) !== 0) {
    await chmod(dir, PRIVATE_DIR_MODE);
    onWarning({
      tr: `${dir} dizini başkalarınca yazılabiliyordu; 0700 yapıldı.`,
      en: `Directory ${dir} was writable by others; changed to 0700.`,
    });
  }
  return true;
}

export type PrivateFileKind = 'secret' | 'config';

/**
 * Reads a UTF-8 file without following a symlink at the last path component (O_NOFOLLOW) and checks the opened
 * handle: regular file, owned by the current user. Loose modes are tightened through the handle (fchmod): secrets
 * must not be readable by others (0600), config must not be writable by others. Returns null when the file is
 * missing.
 */
export async function readPrivateFile(
  file: string,
  kind: PrivateFileKind,
  onWarning: WarningSink = noWarnings,
): Promise<string | null> {
  const flags = constants.O_RDONLY | (IS_POSIX ? constants.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw insecure(file, 'symlink');
    throw error;
  }
  try {
    if (IS_POSIX) {
      const info = await handle.stat();
      if (!info.isFile()) throw insecure(file, 'not-a-file');
      const uid = currentUid();
      if (uid !== undefined && info.uid !== uid) throw ownerError(file, info.uid);
      const loose = kind === 'secret' ? 0o077 : 0o022;
      if ((info.mode & loose) !== 0) {
        await handle.chmod(PRIVATE_FILE_MODE);
        onWarning({
          tr: `${file} dosyasının izinleri fazla açıktı; 0600 yapıldı.`,
          en: `Permissions of ${file} were too open; changed to 0600.`,
        });
      }
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Atomically replaces `file` with `content`: the parent directory is created 0700 and checked
 * ({@link ensurePrivateDir}), a temp file is created with O_EXCL and mode 0600 (no window where the content is
 * readable by others, never follows a planted symlink), fsynced and renamed over the target (rename replaces a
 * symlink instead of following it), then the directory is fsynced. There is no cross-process lock: two concurrent
 * writers (e.g. two `hb login` at once) are last-writer-wins.
 */
export async function writePrivateFile(
  file: string,
  content: string,
  onWarning: WarningSink = noWarnings,
): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await ensurePrivateDir(dir, onWarning);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx', PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content, 'utf8');
    if (IS_POSIX) await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  if (IS_POSIX) {
    const dirHandle = await open(dir, constants.O_RDONLY);
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  }
}

export async function removeIfExists(file: string): Promise<boolean> {
  try {
    await rm(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
