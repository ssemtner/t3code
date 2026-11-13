import {
  CheckpointRef,
  type MachineCheckoutDescription,
  type MachineCheckoutIdentity,
  type MachineWorkingTreeEntry,
  type VcsError,
} from "@t3tools/contracts";
import { parseGitRemoteRepository } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const MACHINE_REFS_PREFIX = "refs/t3/machines/";
export const SNAPSHOT_REFS_PREFIX = "refs/t3/machines/snapshots";
const INCOMING_REFS_PREFIX = "refs/t3/machines/incoming";
// A bundle can only carry named refs, so loose commits (stashes) get one while it is written.
const COMMIT_REFS_PREFIX = "refs/t3/machines/commits";
const GITLINK_MODE = "160000";
const LISTING = {
  maxOutputBytes: 64 * 1024 * 1024,
  outputMode: "error",
  timeoutMs: 120_000,
} as const;
const TRANSFER = { timeoutMs: 10 * 60_000 } as const;
// The scratch index must not share split-index files or an fsmonitor token with the real one.
const SCRATCH_INDEX_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false"];

export class MachineRefNameInvalidError extends Schema.TaggedError<MachineRefNameInvalidError>()(
  "MachineRefNameInvalidError",
  { value: Schema.String },
) {
  override get message(): string {
    return `"${this.value.slice(0, 128)}" is not a valid snapshot, incoming or ref name.`;
  }
}

export class WorkingTreeHeadMissingError extends Schema.TaggedError<WorkingTreeHeadMissingError>()(
  "WorkingTreeHeadMissingError",
  { cwd: Schema.String },
) {
  override get message(): string {
    return "The checkout has no commit yet, so its working tree cannot be snapshotted.";
  }
}

export class SnapshotCommitNotFoundError extends Schema.TaggedError<SnapshotCommitNotFoundError>()(
  "SnapshotCommitNotFoundError",
  { commit: Schema.String },
) {
  override get message(): string {
    return `Snapshot ${this.commit.slice(0, 128)} does not exist in this repository.`;
  }
}

export class SnapshotParentMismatchError extends Schema.TaggedError<SnapshotParentMismatchError>()(
  "SnapshotParentMismatchError",
  {
    snapshotCommit: Schema.String,
    snapshotParent: Schema.NullOr(Schema.String),
    head: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Snapshot ${this.snapshotCommit} was taken on ${this.snapshotParent ?? "no commit"}, but HEAD is ${this.head ?? "unborn"}.`;
  }
}

export class TransferBundleInvalidError extends Schema.TaggedError<TransferBundleInvalidError>()(
  "TransferBundleInvalidError",
  { bundlePath: Schema.String, exitCode: Schema.Number },
) {
  override get message(): string {
    return "The transfer bundle could not be read.";
  }
}

export class TransferBundlePrerequisitesMissingError extends Schema.TaggedError<TransferBundlePrerequisitesMissingError>()(
  "TransferBundlePrerequisitesMissingError",
  { bundlePath: Schema.String, missingCommit: Schema.String },
) {
  override get message(): string {
    return `The transfer bundle needs commit ${this.missingCommit}, which this repository lacks.`;
  }
}

type WorkingTreeSnapshotError =
  | VcsError
  | PlatformError.PlatformError
  | MachineRefNameInvalidError
  | WorkingTreeHeadMissingError
  | SnapshotCommitNotFoundError
  | SnapshotParentMismatchError
  | TransferBundleInvalidError
  | TransferBundlePrerequisitesMissingError;

export class WorkingTreeSnapshot extends Context.Service<
  WorkingTreeSnapshot,
  {
    readonly describeCheckout: (
      cwd: string,
    ) => Effect.Effect<MachineCheckoutDescription, WorkingTreeSnapshotError>;
    /** The checkout's repository and position, without scanning the working tree. */
    readonly describeIdentity: (
      cwd: string,
    ) => Effect.Effect<
      Omit<MachineCheckoutIdentity, "projectId" | "projectRoot">,
      WorkingTreeSnapshotError
    >;
    /** HEAD and branch and remote-tracking tips, newest commit first. */
    readonly listRefTips: (
      cwd: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<string>, WorkingTreeSnapshotError>;
    /** Null when the commits share no history or either is missing here. */
    readonly mergeBase: (
      cwd: string,
      a: string,
      b: string,
    ) => Effect.Effect<string | null, WorkingTreeSnapshotError>;
    readonly readRef: (
      cwd: string,
      ref: string,
    ) => Effect.Effect<string | null, WorkingTreeSnapshotError>;
    /** Only refs under refs/t3/machines/ can be deleted. */
    readonly deleteRefs: (
      cwd: string,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<void, WorkingTreeSnapshotError>;
    /** The listed paths whose working-tree content and mode, or absence, match the snapshot's. */
    readonly pathsUnchangedSince: (
      cwd: string,
      snapshotCommit: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, WorkingTreeSnapshotError>;
    /** Commits the whole working tree on top of HEAD; returns the commit id. */
    readonly snapshotWorkingTree: (
      cwd: string,
      snapshotId: string,
    ) => Effect.Effect<string, WorkingTreeSnapshotError>;
    /** `refs` holds full ref names or commit ids; `haves` the commits the receiver reported. */
    readonly createTransferBundle: (
      cwd: string,
      input: {
        readonly refs: ReadonlyArray<string>;
        readonly haves: ReadonlyArray<string>;
        readonly outputPath: string;
      },
    ) => Effect.Effect<
      { readonly path: string; readonly sizeBytes: number },
      WorkingTreeSnapshotError
    >;
    readonly haveCommits: (
      cwd: string,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, WorkingTreeSnapshotError>;
    /** Returns each imported ref with its commit. */
    readonly importTransferBundle: (
      cwd: string,
      bundlePath: string,
      incomingId: string,
    ) => Effect.Effect<Readonly<Record<string, string>>, WorkingTreeSnapshotError>;
    /**
     * `replaces` names the snapshot the working tree was last made to match, so its files that
     * are untracked here and unchanged since are removed too. Restoring a safety snapshot passes
     * the snapshot that was applied over it.
     */
    readonly applySnapshot: (
      cwd: string,
      snapshotCommit: string,
      options: { readonly safetySnapshotId: string; readonly replaces?: string },
    ) => Effect.Effect<{ readonly safetyCommit: string }, WorkingTreeSnapshotError>;
  }
>()("t3/machines/WorkingTreeSnapshot") {}

const isCommitId = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const isRevision = (value: string) => isCommitId(value) || /^refs\/[^\0\s~^:?*[\\]+$/.test(value);

const validateName = (name: string) =>
  name.length <= 128 &&
  /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name) &&
  !name.endsWith(".lock")
    ? Effect.void
    : Effect.fail(new MachineRefNameInvalidError({ value: name }));

const nulTerminated = (paths: ReadonlyArray<string>) => paths.map((entry) => `${entry}\0`).join("");

const splitNul = (stdout: string) => stdout.split("\0").filter((entry) => entry.length > 0);

function parseStatus(stdout: string) {
  let head: string | null = null;
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const paths = new Set<string>();
  const untracked = new Set<string>();
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid;
    } else if (record.startsWith("# branch.head ")) {
      const name = record.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
    } else if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
    } else if (record.startsWith("# branch.ab ")) {
      const [, aheadCount, behindCount] = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record) ?? [];
      if (aheadCount !== undefined && behindCount !== undefined) {
        ahead = Number(aheadCount);
        behind = Number(behindCount);
      }
    } else if (record.startsWith("? ")) {
      const path = record.slice(2);
      // A nested repository is listed as a directory; snapshots record it only once committed.
      if (!path.endsWith("/")) {
        paths.add(path);
        untracked.add(path);
      }
    } else {
      // Ordinary, renamed and unmerged records carry 8, 9 and 10 fields before the path.
      const fieldCount = { "1": 8, "2": 9, u: 10 }[record[0] ?? ""];
      if (fieldCount === undefined) continue;
      let start = 0;
      for (let field = 0; field < fieldCount; field++) start = record.indexOf(" ", start) + 1;
      paths.add(record.slice(start));
      if (record[0] === "2") paths.add(records[++index] ?? "");
    }
  }
  paths.delete("");
  return {
    head,
    branch,
    upstream: upstream === null ? null : { ref: upstream, ahead, behind },
    paths: [...paths],
    untracked,
  };
}

// Raw `-z` diff output: ":<srcMode> <dstMode> <srcOid> <dstOid> <status>\0<path>\0".
function parseRawDiff(stdout: string) {
  const parts = stdout.split("\0");
  const changes: Array<{
    readonly path: string;
    readonly status: string;
    readonly fromMode: string;
    readonly toMode: string;
    readonly toOid: string;
  }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const [fromMode = "", toMode = "", , toOid = "", status = ""] =
      parts[index]!.slice(1).split(" ");
    changes.push({ path: parts[index + 1]!, status: status.slice(0, 1), fromMode, toMode, toOid });
  }
  return changes;
}

const remoteCanonicalKey = (url: string) =>
  parseGitRemoteRepository(url) === null
    ? null
    : sourceControlDefinitions.repositoryKeyFromRemote(url);

const describeRemotes = (remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>) =>
  remotes.map((remote) => ({
    name: remote.name,
    url: remote.url,
    canonicalKey: remoteCanonicalKey(remote.url),
  }));

const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const driver = yield* registry.get("git").pipe(Effect.orDie);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundleLock = yield* Semaphore.make(1);

  const git = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Omit<
      Parameters<VcsDriver.VcsDriver["Service"]["execute"]>[0],
      "operation" | "cwd" | "args"
    >,
  ) => driver.execute({ operation: `WorkingTreeSnapshot.${operation}`, cwd, args, ...options });

  const resolveRoot = (cwd: string) =>
    git("resolveRoot", cwd, ["rev-parse", "--show-toplevel"]).pipe(
      Effect.map((result) => result.stdout.replace(/\r?\n$/, "")),
    );

  const resolveCommit = (root: string, revision: string) =>
    git("resolveCommit", root, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  const requireCommit = Effect.fnUntraced(function* (root: string, revision: string) {
    const commit = isRevision(revision) ? yield* resolveCommit(root, revision) : null;
    if (commit === null) return yield* new SnapshotCommitNotFoundError({ commit: revision });
    return commit;
  });

  const withScratchIndex = <A, E, R>(use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machines-" });
        return yield* use({ GIT_INDEX_FILE: path.join(directory, "index") });
      }),
    );

  // Hashes the listed paths as `git add` would (filters, symlinks, executable bit) without writing
  // objects, then keeps the ones whose content or mode differs from HEAD.
  const describeEntries = Effect.fn("WorkingTreeSnapshot.describeEntries")(function* (
    root: string,
    head: string | null,
    paths: ReadonlyArray<string>,
    untracked: ReadonlySet<string>,
  ) {
    if (paths.length === 0) return [];
    const base =
      head ??
      (yield* git("emptyTree", root, ["hash-object", "-t", "tree", "--stdin"], {
        stdin: "",
      })).stdout.trim();
    const diff = yield* withScratchIndex((env) =>
      Effect.gen(function* () {
        if (head !== null)
          yield* git("readTree", root, [...SCRATCH_INDEX_CONFIG, "read-tree", head], { env });
        yield* git(
          "hashEntries",
          root,
          [
            ...SCRATCH_INDEX_CONFIG,
            "update-index",
            "--add",
            "--remove",
            "--info-only",
            "-z",
            "--stdin",
          ],
          { env, stdin: nulTerminated(paths), ...LISTING },
        );
        return yield* git(
          "diffEntries",
          root,
          ["diff-index", "--cached", "-z", "--no-renames", "--no-abbrev", base],
          { env, ...LISTING },
        );
      }),
    );
    return parseRawDiff(diff.stdout)
      .map((change): MachineWorkingTreeEntry => {
        if (change.status === "D")
          return { path: change.path, kind: "deleted", mode: null, blobId: null };
        const kind =
          change.status === "A" ? (untracked.has(change.path) ? "untracked" : "added") : "modified";
        return { path: change.path, kind, mode: change.toMode, blobId: change.toOid };
      })
      .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  });

  const listRootCommits = (root: string, head: string | null) =>
    head === null
      ? Effect.succeed([])
      : git("rootCommits", root, ["rev-list", "--max-parents=0", head], LISTING).pipe(
          Effect.map((result) => result.stdout.split("\n").filter((line) => line.length > 0)),
        );

  const describeIdentity = Effect.fn("WorkingTreeSnapshot.describeIdentity")(function* (
    cwd: string,
  ) {
    const checkoutRoot = yield* resolveRoot(cwd);
    const [head, branch, remotes] = yield* Effect.all(
      [
        resolveCommit(checkoutRoot, "HEAD"),
        git("branch", checkoutRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
          allowNonZeroExit: true,
        }).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null))),
        driver.listRemotes(checkoutRoot),
      ],
      { concurrency: "unbounded" },
    );
    return {
      checkoutRoot,
      head,
      branch,
      remotes: describeRemotes(remotes.remotes),
      rootCommits: yield* listRootCommits(checkoutRoot, head),
    };
  });

  const listRefTips = Effect.fn("WorkingTreeSnapshot.listRefTips")(function* (
    cwd: string,
    limit: number,
  ) {
    const root = yield* resolveRoot(cwd);
    // --no-walk lists just the tips, deduplicated, newest commit first.
    const result = yield* git(
      "listRefTips",
      root,
      [
        "rev-list",
        "--no-walk",
        "--ignore-missing",
        `--max-count=${Math.max(0, Math.floor(limit))}`,
        "HEAD",
        "--branches",
        "--remotes",
      ],
      LISTING,
    );
    return result.stdout.split("\n").filter(isCommitId);
  });

  const mergeBase = Effect.fn("WorkingTreeSnapshot.mergeBase")(function* (
    cwd: string,
    a: string,
    b: string,
  ) {
    const root = yield* resolveRoot(cwd);
    const present = yield* haveCommitsAt(root, [a, b]);
    if (!present.includes(a) || !present.includes(b)) return null;
    const result = yield* git("mergeBase", root, ["merge-base", a, b], {
      allowNonZeroExit: true,
      env: { GIT_NO_LAZY_FETCH: "1" },
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  });

  const readRef = Effect.fn("WorkingTreeSnapshot.readRef")(function* (cwd: string, ref: string) {
    if (!isRevision(ref)) return yield* new MachineRefNameInvalidError({ value: ref });
    return yield* resolveCommit(yield* resolveRoot(cwd), ref);
  });

  const deleteRefs = Effect.fn("WorkingTreeSnapshot.deleteRefs")(function* (
    cwd: string,
    refs: ReadonlyArray<string>,
  ) {
    for (const ref of refs) {
      if (!isRevision(ref) || !ref.startsWith(MACHINE_REFS_PREFIX)) {
        return yield* new MachineRefNameInvalidError({ value: ref });
      }
    }
    if (refs.length === 0) return;
    yield* git("deleteRefs", yield* resolveRoot(cwd), ["update-ref", "--stdin"], {
      stdin: refs.map((ref) => `delete ${ref}\n`).join(""),
    });
  });

  const describeCheckout = Effect.fn("WorkingTreeSnapshot.describeCheckout")(function* (
    cwd: string,
  ) {
    const root = yield* resolveRoot(cwd);
    const [status, remotes, stashList] = yield* Effect.all(
      [
        // No optional locks: describing must not rewrite the user's index.
        git(
          "status",
          root,
          [
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--no-renames",
          ],
          LISTING,
        ),
        driver.listRemotes(root),
        git("stashes", root, ["stash", "list", "--format=%H%x00%P%x00%s"], LISTING),
      ],
      { concurrency: "unbounded" },
    );
    const parsed = parseStatus(status.stdout);
    const [rootCommits, entries] = yield* Effect.all(
      [
        listRootCommits(root, parsed.head),
        describeEntries(root, parsed.head, parsed.paths, parsed.untracked),
      ],
      { concurrency: "unbounded" },
    );
    return {
      head: parsed.head,
      branch: parsed.branch,
      upstream: parsed.upstream,
      remotes: describeRemotes(remotes.remotes),
      rootCommits,
      entries,
      stashes: stashList.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [commit = "", parents = "", subject = ""] = line.split("\0");
          return { commit, baseCommit: parents.split(" ")[0] ?? "", subject };
        }),
    } satisfies MachineCheckoutDescription;
  });

  const pathsUnchangedSince = Effect.fn("WorkingTreeSnapshot.pathsUnchangedSince")(function* (
    cwd: string,
    snapshotCommit: string,
    paths: ReadonlyArray<string>,
  ) {
    const root = yield* resolveRoot(cwd);
    const snapshot = yield* requireCommit(root, snapshotCommit);
    if (paths.length === 0) return [];
    // describeEntries' hashing, against the snapshot's tree instead of HEAD.
    const diff = yield* withScratchIndex((env) =>
      Effect.gen(function* () {
        yield* git("readSnapshot", root, [...SCRATCH_INDEX_CONFIG, "read-tree", snapshot], {
          env,
        });
        yield* git(
          "hashPaths",
          root,
          [
            ...SCRATCH_INDEX_CONFIG,
            "update-index",
            "--add",
            "--remove",
            "--info-only",
            "-z",
            "--stdin",
          ],
          { env, stdin: nulTerminated(paths), ...LISTING },
        );
        return yield* git(
          "diffPaths",
          root,
          ["diff-index", "--cached", "-z", "--no-renames", "--name-only", snapshot],
          { env, ...LISTING },
        );
      }),
    );
    const changed = new Set(splitNul(diff.stdout));
    return paths.filter((entry) => !changed.has(entry));
  });

  const snapshotWorkingTree = Effect.fn("WorkingTreeSnapshot.snapshotWorkingTree")(function* (
    cwd: string,
    snapshotId: string,
  ) {
    yield* validateName(snapshotId);
    const root = yield* resolveRoot(cwd);
    if ((yield* resolveCommit(root, "HEAD")) === null) {
      return yield* new WorkingTreeHeadMissingError({ cwd: root });
    }
    const ref = `${SNAPSHOT_REFS_PREFIX}/${snapshotId}`;
    // The turn checkpoint capture: a scratch index, untracked files included, ignored ones not.
    yield* driver.checkpoints.captureCheckpoint({
      cwd: root,
      checkpointRef: CheckpointRef.make(ref),
    });
    return yield* requireCommit(root, ref).pipe(Effect.orDie);
  });

  // Untraced: it runs inside haveCommits' and createTransferBundle's spans.
  const haveCommitsAt = Effect.fnUntraced(function* (root: string, ids: ReadonlyArray<string>) {
    const candidates = [...new Set(ids.filter(isCommitId))];
    if (candidates.length === 0) return [];
    const result = yield* git(
      "haveCommits",
      root,
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      {
        stdin: `${candidates.join("\n")}\n`,
        // A partial clone would otherwise try to download each missing object.
        env: { GIT_NO_LAZY_FETCH: "1" },
        ...LISTING,
      },
    );
    const present = new Set(
      result.stdout
        .split("\n")
        .filter((line) => line.endsWith(" commit"))
        .map((line) => line.slice(0, line.indexOf(" "))),
    );
    return candidates.filter((id) => present.has(id));
  });

  const createTransferBundle = Effect.fn("WorkingTreeSnapshot.createTransferBundle")(function* (
    cwd: string,
    input: {
      readonly refs: ReadonlyArray<string>;
      readonly haves: ReadonlyArray<string>;
      readonly outputPath: string;
    },
  ) {
    for (const ref of input.refs) {
      if (!isRevision(ref)) return yield* new MachineRefNameInvalidError({ value: ref });
    }
    const root = yield* resolveRoot(cwd);
    const outputPath = path.resolve(input.outputPath);
    const haves = yield* haveCommitsAt(root, input.haves);
    const commitRefs = new Map(
      input.refs.filter(isCommitId).map((commit) => [commit, `${COMMIT_REFS_PREFIX}/${commit}`]),
    );
    const refs = [...new Set(input.refs.map((ref) => commitRefs.get(ref) ?? ref))];
    // Concurrent bundles would otherwise delete each other's commit refs.
    yield* bundleLock.withPermits(1)(
      Effect.gen(function* () {
        for (const [commit, ref] of commitRefs) {
          yield* git("createTransferBundle.commitRef", root, ["update-ref", ref, commit]);
        }
        yield* git(
          "createTransferBundle",
          root,
          [
            "bundle",
            "create",
            "--quiet",
            outputPath,
            ...refs,
            ...(haves.length > 0 ? ["--not", ...haves] : []),
          ],
          TRANSFER,
        );
      }).pipe(
        Effect.ensuring(
          Effect.forEach(
            commitRefs,
            ([commit, ref]) =>
              git("createTransferBundle.removeCommitRef", root, ["update-ref", "-d", ref, commit], {
                allowNonZeroExit: true,
              }).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      ),
    );
    const info = yield* fileSystem.stat(outputPath);
    return { path: outputPath, sizeBytes: Number(info.size) };
  });

  const importTransferBundle = Effect.fn("WorkingTreeSnapshot.importTransferBundle")(function* (
    cwd: string,
    bundlePath: string,
    incomingId: string,
  ) {
    yield* validateName(incomingId);
    const root = yield* resolveRoot(cwd);
    const absolutePath = path.resolve(bundlePath);
    // Not --quiet: that also drops the list of missing prerequisites.
    const verify = yield* git(
      "importTransferBundle.verify",
      root,
      ["bundle", "verify", absolutePath],
      {
        allowNonZeroExit: true,
        env: { LC_ALL: "C" },
        ...TRANSFER,
      },
    );
    if (verify.exitCode !== 0) {
      const [, missingCommit] =
        /lacks these prerequisite commits:\s*\n(?:error: )?([0-9a-f]{40,64})/.exec(verify.stderr) ??
        [];
      return yield* missingCommit === undefined
        ? new TransferBundleInvalidError({ bundlePath: absolutePath, exitCode: verify.exitCode })
        : new TransferBundlePrerequisitesMissingError({ bundlePath: absolutePath, missingCommit });
    }
    const heads = yield* git(
      "importTransferBundle.listHeads",
      root,
      ["bundle", "list-heads", absolutePath],
      LISTING,
    );
    const prefix = `${INCOMING_REFS_PREFIX}/${incomingId}/`;
    // An explicit refspec into our own namespace leaves branches, HEAD and the working tree alone.
    yield* git(
      "importTransferBundle.fetch",
      root,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        absolutePath,
        `+refs/*:${prefix}*`,
      ],
      TRANSFER,
    );
    return Object.fromEntries(
      heads.stdout.split("\n").flatMap((line) => {
        const [, commit, ref] = /^([0-9a-f]+) refs\/(.+)$/.exec(line) ?? [];
        return commit === undefined || ref === undefined ? [] : [[`${prefix}${ref}`, commit]];
      }),
    );
  });

  const applySnapshot = Effect.fn("WorkingTreeSnapshot.applySnapshot")(function* (
    cwd: string,
    snapshotCommit: string,
    options: { readonly safetySnapshotId: string; readonly replaces?: string },
  ) {
    yield* validateName(options.safetySnapshotId);
    const root = yield* resolveRoot(cwd);
    const target = yield* requireCommit(root, snapshotCommit);
    const [parent, head] = yield* Effect.all([
      resolveCommit(root, `${target}^1`),
      resolveCommit(root, "HEAD"),
    ]);
    if (parent !== head) {
      return yield* new SnapshotParentMismatchError({
        snapshotCommit: target,
        snapshotParent: parent,
        head,
      });
    }
    const replaced =
      options.replaces === undefined ? null : yield* requireCommit(root, options.replaces);
    const safetyCommit = yield* snapshotWorkingTree(root, options.safetySnapshotId);

    // The safety snapshot is the working tree as it stands, so this diff is exactly what to change.
    // Gitlinks are skipped: removing or rewriting one would touch a nested repository.
    const changes = parseRawDiff(
      (yield* git(
        "applySnapshot.diff",
        root,
        ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", safetyCommit, target],
        LISTING,
      )).stdout,
    );
    const writes = changes
      .filter((change) => change.status !== "D" && change.toMode !== GITLINK_MODE)
      .map((change) => change.path);
    const candidates = changes
      .filter((change) => change.status === "D" && change.fromMode !== GITLINK_MODE)
      .map((change) => change.path);

    let removals: ReadonlyArray<string> = [];
    if (candidates.length > 0) {
      // Absent from the snapshot and tracked here (in HEAD or staged) means delete. Untracked
      // files stay unless they came from `replaces` and are unchanged since.
      const [headPaths, stagedAdditions, changedSinceReplaced] = yield* Effect.all(
        [
          git(
            "applySnapshot.headRemovals",
            root,
            [
              "diff-tree",
              "-r",
              "-z",
              "--no-renames",
              "--name-only",
              "--diff-filter=D",
              "HEAD",
              target,
            ],
            LISTING,
          ),
          git(
            "applySnapshot.stagedAdditions",
            root,
            [
              "--no-optional-locks",
              "diff-index",
              "--cached",
              "-z",
              "--no-renames",
              "--name-only",
              "--diff-filter=A",
              "HEAD",
            ],
            LISTING,
          ),
          replaced === null
            ? Effect.succeed(null)
            : git(
                "applySnapshot.replaced",
                root,
                ["diff-tree", "-r", "-z", "--no-renames", "--name-only", safetyCommit, replaced],
                LISTING,
              ),
        ],
        { concurrency: "unbounded" },
      );
      const tracked = new Set([...splitNul(headPaths.stdout), ...splitNul(stagedAdditions.stdout)]);
      const changed =
        changedSinceReplaced === null ? null : new Set(splitNul(changedSinceReplaced.stdout));
      removals = candidates.filter(
        (entry) => tracked.has(entry) || (changed !== null && !changed.has(entry)),
      );
    }

    yield* withScratchIndex((env) =>
      Effect.gen(function* () {
        if (removals.length > 0) {
          yield* git(
            "applySnapshot.readCurrent",
            root,
            [...SCRATCH_INDEX_CONFIG, "read-tree", safetyCommit],
            { env },
          );
          // rm also prunes directories it empties.
          yield* git(
            "applySnapshot.remove",
            root,
            [
              ...SCRATCH_INDEX_CONFIG,
              "rm",
              "-f",
              "-q",
              "--ignore-unmatch",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            {
              env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
              stdin: nulTerminated(removals),
              ...LISTING,
            },
          );
        }
        if (writes.length > 0) {
          yield* git(
            "applySnapshot.readTarget",
            root,
            [...SCRATCH_INDEX_CONFIG, "read-tree", target],
            { env },
          );
          yield* git(
            "applySnapshot.write",
            root,
            [...SCRATCH_INDEX_CONFIG, "checkout-index", "-f", "-z", "--stdin"],
            { env, stdin: nulTerminated(writes), ...LISTING },
          );
        }
      }),
    );
    // Changes show as unstaged; files untracked in the snapshot stay untracked.
    yield* git("applySnapshot.resetIndex", root, ["reset", "--quiet", "--", "."]);
    return { safetyCommit };
  });

  return WorkingTreeSnapshot.of({
    describeCheckout,
    describeIdentity,
    listRefTips,
    mergeBase,
    readRef,
    deleteRefs,
    pathsUnchangedSince,
    snapshotWorkingTree,
    createTransferBundle,
    haveCommits: Effect.fn("WorkingTreeSnapshot.haveCommits")(function* (cwd, ids) {
      return yield* haveCommitsAt(yield* resolveRoot(cwd), ids);
    }),
    importTransferBundle,
    applySnapshot,
  });
});

export const layer = Layer.effect(WorkingTreeSnapshot, make);
