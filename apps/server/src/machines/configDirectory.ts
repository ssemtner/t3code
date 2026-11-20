import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const WALK_MAX_DEPTH = 8;
const WALK_MAX_FILES = 2_000;

const encoder = new TextEncoder();

// Untraced: these run per file or per skill inside one scan, read, write or plan step span.

const sha256Hex = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const digest = yield* Digest.Digest;
  return yield* digest.digestHex(Digest.sha256, bytes);
});

/** `/`-separated path of `file` below `root`, the same on every platform. */
export const relativeKey = (path: Path.Path, root: string, file: string) =>
  path.relative(root, file).split(path.sep).join("/");

/** Follows symlinks (stat) and skips dot entries such as .DS_Store, which differ by machine. */
export const listFiles = Effect.fnUntraced(function* (
  root: string,
  accept: (name: string) => boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const pending: Array<{ readonly directory: string; readonly depth: number }> = [
    { directory: root, depth: 0 },
  ];
  while (files.length < WALK_MAX_FILES) {
    const next = pending.shift();
    if (next === undefined) break;
    const { directory, depth } = next;
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries.toSorted()) {
      if (entry.startsWith(".")) continue;
      const entryPath = path.join(directory, entry);
      const info = yield* fileSystem.stat(entryPath).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type === "Directory" && depth < WALK_MAX_DEPTH) {
        pending.push({ directory: entryPath, depth: depth + 1 });
      } else if (info?.type === "File" && accept(entry)) {
        files.push(entryPath);
      }
    }
  }
  return files.toSorted();
});

/**
 * Digest of a directory: sha256 over `<relative path>\0<file sha256>\n` lines in path order.
 * Inventory hashes, item reads and copy-config preconditions all compare this value.
 */
const directoryDigest = (
  entries: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
) =>
  sha256Hex(
    encoder.encode(
      entries
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((entry) => `${entry.path}\0${entry.sha256}\n`)
        .join(""),
    ),
  );

/** The directory digest of files held in memory. */
export const directoryDigestOfFiles = Effect.fnUntraced(function* (
  files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
) {
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const file of files) entries.push({ path: file.path, sha256: yield* sha256Hex(file.bytes) });
  return yield* directoryDigest(entries);
});

/** Digest of a directory on disk, read one file at a time; unreadable files hash as empty. */
export const directoryDigestOnDisk = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Array<{ path: string; sha256: string }> = [];
  let sizeBytes = 0;
  for (const file of yield* listFiles(root, () => true)) {
    const bytes = yield* fileSystem
      .readFile(file)
      .pipe(Effect.orElseSucceed(() => new Uint8Array()));
    sizeBytes += bytes.byteLength;
    entries.push({ path: relativeKey(path, root, file), sha256: yield* sha256Hex(bytes) });
  }
  return { sha256: yield* directoryDigest(entries), sizeBytes, fileCount: entries.length };
});
