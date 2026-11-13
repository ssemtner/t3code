import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkingTreeSnapshot from "./WorkingTreeSnapshot.ts";

const layer = WorkingTreeSnapshot.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const UNICODE_PATH = "dir/ünï cödé file.txt";

const git = Effect.fn("test.git")(function* (cwd: string, ...args: ReadonlyArray<string>) {
  const driver = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git");
  return (yield* driver.execute({ operation: "test.git", cwd, args })).stdout;
});

const write = Effect.fn("test.write")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, relativePath)), { recursive: true });
  yield* fileSystem.writeFileString(path.join(cwd, relativePath), contents);
});

const read = Effect.fn("test.read")(function* (cwd: string, relativePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(cwd, relativePath);
  return (yield* fileSystem.exists(absolute)) ? yield* fileSystem.readFileString(absolute) : null;
});

const chmod = Effect.fn("test.chmod")(function* (cwd: string, relativePath: string, mode: number) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.chmod(path.join(cwd, relativePath), mode);
});

const configure = (cwd: string) =>
  Effect.forEach(
    [
      ["user.name", "Test"],
      ["user.email", "test@test.com"],
    ],
    ([key, value]) => git(cwd, "config", key!, value!),
    { discard: true },
  );

const tempDirectory = Effect.fn("test.tempDirectory")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-machines-test-" });
});

const makeRepo = Effect.fn("test.makeRepo")(function* (files: Readonly<Record<string, string>>) {
  const cwd = yield* tempDirectory();
  yield* git(cwd, "init", "-q", "-b", "main");
  yield* configure(cwd);
  for (const [relativePath, contents] of Object.entries(files))
    yield* write(cwd, relativePath, contents);
  yield* git(cwd, "add", "-A");
  yield* git(cwd, "commit", "-q", "-m", "initial");
  return cwd;
});

const cloneRepo = Effect.fn("test.cloneRepo")(function* (source: string) {
  const cwd = yield* tempDirectory();
  yield* git(cwd, "clone", "-q", source, ".");
  yield* configure(cwd);
  return cwd;
});

const commit = Effect.fn("test.commit")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  yield* write(cwd, relativePath, contents);
  yield* git(cwd, "add", "--", relativePath);
  yield* git(cwd, "commit", "-q", "-m", `edit ${relativePath}`);
  return (yield* git(cwd, "rev-parse", "HEAD")).trim();
});

const repoState = Effect.fn("test.repoState")(function* (cwd: string) {
  return {
    status: yield* git(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    stashes: yield* git(cwd, "stash", "list", "--format=%H"),
    head: yield* git(cwd, "rev-parse", "HEAD"),
    branches: yield* git(cwd, "for-each-ref", "refs/heads", "refs/remotes"),
  };
});

// Tracked and staged edits, a deletion, untracked and ignored files, a stash.
const makeDirtyRepo = Effect.fn("test.makeDirtyRepo")(function* () {
  const cwd = yield* makeRepo({
    ".gitignore": "*.log\n",
    "tracked.txt": "one\n",
    "staged.txt": "staged\n",
    "gone.txt": "bye\n",
  });
  yield* write(cwd, "tracked.txt", "stashed\n");
  yield* git(cwd, "stash", "push", "-q");
  yield* write(cwd, "tracked.txt", "two\n");
  yield* write(cwd, "staged.txt", "staged edit\n");
  yield* git(cwd, "add", "staged.txt");
  yield* git(cwd, "rm", "-q", "gone.txt");
  yield* write(cwd, UNICODE_PATH, "untracked\n");
  yield* write(cwd, "debug.log", "ignored\n");
  return cwd;
});

it.live("snapshots the working tree without touching index, worktree, HEAD or stashes", () =>
  Effect.gen(function* () {
    const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const cwd = yield* makeDirtyRepo();
    const head = (yield* git(cwd, "rev-parse", "HEAD")).trim();
    const before = yield* repoState(cwd);

    const snapshot = yield* service.snapshotWorkingTree(cwd, "first");

    assert.deepStrictEqual(yield* repoState(cwd), before);
    assert.strictEqual(
      (yield* git(cwd, "rev-parse", "refs/t3/machines/snapshots/first")).trim(),
      snapshot,
    );
    assert.strictEqual((yield* git(cwd, "rev-parse", `${snapshot}^@`)).trim(), head);
    assert.strictEqual(yield* git(cwd, "show", `${snapshot}:tracked.txt`), "two\n");
    assert.strictEqual(yield* git(cwd, "show", `${snapshot}:staged.txt`), "staged edit\n");
    assert.strictEqual(yield* git(cwd, "show", `${snapshot}:${UNICODE_PATH}`), "untracked\n");
    const tree = yield* git(cwd, "ls-tree", "-r", "-z", "--full-tree", snapshot);
    const entries = tree.split("\0").filter((entry) => entry.length > 0);
    assert.isFalse(entries.some((entry) => entry.endsWith("\tdebug.log")));
    assert.isFalse(entries.some((entry) => entry.endsWith("\tgone.txt")));

    const clean = yield* makeRepo({ "a.txt": "a\n" });
    const cleanSnapshot = yield* service.snapshotWorkingTree(clean, "clean");
    assert.strictEqual(
      (yield* git(clean, "rev-parse", `${cleanSnapshot}^{tree}`)).trim(),
      (yield* git(clean, "rev-parse", "HEAD^{tree}")).trim(),
    );
    assert.strictEqual(
      (yield* service.snapshotWorkingTree(clean, "../escape").pipe(Effect.flip))._tag,
      "MachineRefNameInvalidError",
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("describes remotes, upstream, roots, changed entries and stashes", () =>
  Effect.gen(function* () {
    const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const source = yield* makeDirtyRepo();
    const cwd = yield* cloneRepo(source);
    yield* git(cwd, "remote", "add", "personal", "git@github.com:Octo/Repo.git");
    yield* commit(cwd, "ahead.txt", "ahead\n");
    yield* write(cwd, "tracked.txt", "stashed\n");
    yield* git(cwd, "stash", "push", "-q");
    yield* write(cwd, UNICODE_PATH, "untracked\n");
    yield* write(cwd, "debug.log", "ignored\n");
    yield* git(cwd, "rm", "-q", "gone.txt");
    yield* write(cwd, "staged.txt", "new\n");
    yield* write(cwd, "added.txt", "added\n");
    yield* git(cwd, "add", "staged.txt", "added.txt");

    const description = yield* service.describeCheckout(cwd);

    const head = (yield* git(cwd, "rev-parse", "HEAD")).trim();
    assert.strictEqual(description.head, head);
    assert.deepStrictEqual(yield* service.describeIdentity(cwd), {
      checkoutRoot: (yield* git(cwd, "rev-parse", "--show-toplevel")).trim(),
      head,
      branch: "main",
      remotes: description.remotes,
      rootCommits: description.rootCommits,
    });
    assert.strictEqual(description.branch, "main");
    assert.deepStrictEqual(description.upstream, { ref: "origin/main", ahead: 1, behind: 0 });
    assert.deepStrictEqual(
      description.remotes.map((remote) => [remote.name, remote.canonicalKey]),
      [
        ["origin", null],
        ["personal", "github.com/octo/repo"],
      ],
    );
    assert.deepStrictEqual(description.rootCommits, [
      (yield* git(cwd, "rev-list", "--max-parents=0", "HEAD")).trim(),
    ]);
    const blob = (relativePath: string) =>
      git(cwd, "hash-object", "--", relativePath).pipe(Effect.map((stdout) => stdout.trim()));
    assert.deepStrictEqual(description.entries, [
      { path: "added.txt", kind: "added", mode: "100644", blobId: yield* blob("added.txt") },
      { path: UNICODE_PATH, kind: "untracked", mode: "100644", blobId: yield* blob(UNICODE_PATH) },
      { path: "gone.txt", kind: "deleted", mode: null, blobId: null },
      { path: "staged.txt", kind: "modified", mode: "100644", blobId: yield* blob("staged.txt") },
    ]);
    assert.deepStrictEqual(description.stashes, [
      {
        commit: (yield* git(cwd, "rev-parse", "refs/stash")).trim(),
        baseCommit: head,
        subject: "WIP on main: " + (yield* git(cwd, "log", "-1", "--format=%h %s")).trim(),
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("lists ref tips newest first, finds merge bases, and reads and deletes refs", () =>
  Effect.gen(function* () {
    const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const driver = yield* (yield* VcsDriverRegistry.VcsDriverRegistry).get("git");
    const datedCommit = Effect.fn("test.datedCommit")(function* (cwd: string, date: string) {
      const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      const args = ["commit", "-q", "--allow-empty", "-m", date];
      yield* driver.execute({ operation: "test.datedCommit", cwd, args, env });
      return (yield* git(cwd, "rev-parse", "HEAD")).trim();
    });
    const cwd = yield* makeRepo({ "a.txt": "a\n" });
    const base = (yield* git(cwd, "rev-parse", "HEAD")).trim();
    const main = yield* datedCommit(cwd, "2030-01-01T00:00:00Z");
    yield* git(cwd, "checkout", "-q", "-b", "side", base);
    const side = yield* datedCommit(cwd, "2031-01-01T00:00:00Z");
    yield* git(cwd, "checkout", "-q", "main");
    yield* git(cwd, "update-ref", "refs/remotes/origin/main", base);
    const orphan = (yield* git(cwd, "commit-tree", "HEAD^{tree}", "-m", "orphan")).trim();

    assert.deepStrictEqual(yield* service.listRefTips(cwd, 10), [side, main, base]);
    assert.deepStrictEqual(yield* service.listRefTips(cwd, 2), [side, main]);
    assert.strictEqual(yield* service.mergeBase(cwd, main, side), base);
    assert.isNull(yield* service.mergeBase(cwd, main, orphan));
    assert.isNull(yield* service.mergeBase(cwd, main, "f".repeat(40)));
    assert.strictEqual(yield* service.readRef(cwd, "refs/heads/side"), side);
    assert.isNull(yield* service.readRef(cwd, "refs/t3/machines/snapshots/missing"));
    assert.strictEqual(
      (yield* service.readRef(cwd, "HEAD~1").pipe(Effect.flip))._tag,
      "MachineRefNameInvalidError",
    );

    const machineRefs = ["refs/t3/machines/snapshots/x", "refs/t3/machines/incoming/y/heads/z"];
    for (const ref of machineRefs) yield* git(cwd, "update-ref", ref, main);
    yield* service.deleteRefs(cwd, [...machineRefs, "refs/t3/machines/snapshots/never"]);
    assert.strictEqual(yield* git(cwd, "for-each-ref", "refs/t3/machines"), "");
    assert.strictEqual(
      (yield* service.deleteRefs(cwd, ["refs/heads/side"]).pipe(Effect.flip))._tag,
      "MachineRefNameInvalidError",
    );
    assert.strictEqual(yield* service.readRef(cwd, "refs/heads/side"), side);

    yield* git(cwd, "checkout", "-q", "--detach", side);
    assert.isNull((yield* service.describeIdentity(cwd)).branch);
    const unborn = yield* tempDirectory();
    yield* git(unborn, "init", "-q", "-b", "main");
    assert.deepStrictEqual(yield* service.listRefTips(unborn, 10), []);
    const identity = yield* service.describeIdentity(unborn);
    assert.deepStrictEqual(
      [identity.head, identity.branch, identity.rootCommits],
      [null, "main", []],
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("moves a snapshot and a stash between clones by bundle, with and without haves", () =>
  Effect.gen(function* () {
    const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* makeRepo({
      "a.txt": "a\n",
      // Incompressible enough that leaving it out of the thin bundle shows in its size.
      "big.txt": Array.from({ length: 20_000 }, (_, index) =>
        ((index * 7919) % 10_007).toString(36),
      ).join("\n"),
    });
    const destination = yield* cloneRepo(source);
    const shared = (yield* git(source, "rev-parse", "HEAD")).trim();
    const sourceHead = yield* commit(source, "a.txt", "a2\n");
    yield* write(source, "a.txt", "stash me\n");
    yield* git(source, "stash", "push", "-q");
    const stash = (yield* git(source, "rev-parse", "refs/stash")).trim();
    yield* write(source, "new.txt", "new\n");
    const snapshot = yield* service.snapshotWorkingTree(source, "move");

    const haves = yield* service.haveCommits(destination, [sourceHead, shared, "not-a-commit"]);
    assert.deepStrictEqual(haves, [shared]);
    const scratch = yield* tempDirectory();
    const refs = ["refs/t3/machines/snapshots/move", stash];
    const thin = yield* service.createTransferBundle(source, {
      refs,
      haves: [...haves, "f".repeat(40)],
      outputPath: path.join(scratch, "thin.bundle"),
    });
    const full = yield* service.createTransferBundle(source, {
      refs,
      haves: [],
      outputPath: path.join(scratch, "full.bundle"),
    });
    assert.isBelow(thin.sizeBytes, full.sizeBytes);
    assert.strictEqual(Number((yield* fileSystem.stat(thin.path)).size), thin.sizeBytes);
    assert.strictEqual(yield* git(source, "for-each-ref", "refs/t3/machines/commits"), "");

    const expected = (incomingId: string) => ({
      [`refs/t3/machines/incoming/${incomingId}/t3/machines/snapshots/move`]: snapshot,
      [`refs/t3/machines/incoming/${incomingId}/t3/machines/commits/${stash}`]: stash,
    });
    const before = yield* repoState(destination);
    assert.deepStrictEqual(
      yield* service.importTransferBundle(destination, thin.path, "thin"),
      expected("thin"),
    );
    assert.deepStrictEqual(yield* repoState(destination), before);
    assert.strictEqual(
      yield* git(
        destination,
        "show",
        "refs/t3/machines/incoming/thin/t3/machines/snapshots/move:new.txt",
      ),
      "new\n",
    );

    const unrelated = yield* makeRepo({ "other.txt": "other\n" });
    const missing = yield* service
      .importTransferBundle(unrelated, thin.path, "thin")
      .pipe(Effect.flip);
    assert.strictEqual(missing._tag, "TransferBundlePrerequisitesMissingError");
    assert.strictEqual(
      missing._tag === "TransferBundlePrerequisitesMissingError" ? missing.missingCommit : null,
      shared,
    );
    assert.deepStrictEqual(
      yield* service.importTransferBundle(unrelated, full.path, "full"),
      expected("full"),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("applies a snapshot over another checkout and restores the safety snapshot exactly", () =>
  Effect.gen(function* () {
    const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const path = yield* Path.Path;
    const files = {
      ".gitignore": "*.log\n",
      "edited.txt": "base\n",
      "old.txt": "old\n",
      "dest-edit.txt": "base\n",
      "nested/keep.txt": "keep\n",
      "nested/drop.txt": "drop\n",
    };
    const source = yield* makeRepo(files);
    const destination = yield* cloneRepo(source);
    yield* write(source, "edited.txt", "from source\n");
    yield* git(source, "rm", "-q", "old.txt", "nested/drop.txt");
    yield* write(source, UNICODE_PATH, "source untracked\n");
    yield* write(source, "clash.txt", "source clash\n");
    const snapshotId = "apply";
    yield* service.snapshotWorkingTree(source, snapshotId);
    const scratch = yield* tempDirectory();
    const bundle = yield* service.createTransferBundle(source, {
      refs: [`refs/t3/machines/snapshots/${snapshotId}`],
      haves: [],
      outputPath: path.join(scratch, "apply.bundle"),
    });
    const imported = yield* service.importTransferBundle(destination, bundle.path, "in");
    const snapshot = imported["refs/t3/machines/incoming/in/t3/machines/snapshots/apply"]!;

    yield* write(destination, "dest-edit.txt", "destination edit\n");
    yield* write(destination, "edited.txt", "destination staged\n");
    yield* git(destination, "add", "edited.txt");
    yield* write(destination, "mine.txt", "destination only\n");
    yield* write(destination, "clash.txt", "destination clash\n");
    yield* write(destination, "local.log", "ignored\n");
    const before = yield* service.describeCheckout(destination);
    const stashesBefore = yield* git(destination, "stash", "list");

    const { safetyCommit } = yield* service.applySnapshot(destination, snapshot, {
      safetySnapshotId: "safety",
    });

    const sourceDescription = yield* service.describeCheckout(source);
    const applied = yield* service.describeCheckout(destination);
    assert.deepStrictEqual(
      applied.entries.filter((entry) => entry.path !== "mine.txt"),
      sourceDescription.entries,
    );
    assert.deepStrictEqual(
      applied.entries.find((entry) => entry.path === "mine.txt")?.kind,
      "untracked",
    );
    assert.strictEqual(yield* read(destination, "dest-edit.txt"), "base\n");
    assert.strictEqual(yield* read(destination, "old.txt"), null);
    assert.strictEqual(yield* read(destination, "nested/drop.txt"), null);
    assert.strictEqual(yield* read(destination, "local.log"), "ignored\n");
    assert.strictEqual(yield* git(destination, "diff", "--cached", "--name-only"), "");
    assert.include(
      yield* git(destination, "status", "--porcelain=v1", "--untracked-files=all"),
      "?? clash.txt\n",
    );
    assert.strictEqual(
      (yield* git(destination, "rev-parse", "refs/t3/machines/snapshots/safety")).trim(),
      safetyCommit,
    );

    yield* service.applySnapshot(destination, safetyCommit, {
      safetySnapshotId: "undo",
      replaces: snapshot,
    });

    const restored = yield* service.describeCheckout(destination);
    assert.deepStrictEqual(restored.entries, before.entries);
    for (const relativePath of [
      "dest-edit.txt",
      "edited.txt",
      "mine.txt",
      "clash.txt",
      "old.txt",
    ]) {
      assert.strictEqual(
        yield* read(destination, relativePath),
        yield* git(destination, "show", `${safetyCommit}:${relativePath}`),
      );
    }
    assert.strictEqual(yield* read(destination, UNICODE_PATH), null);
    assert.strictEqual(yield* git(destination, "stash", "list"), stashesBefore);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("refuses to apply a snapshot taken on another HEAD and changes nothing", () =>
  Effect.gen(function* () {
    const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const cwd = yield* makeRepo({ "a.txt": "a\n" });
    yield* write(cwd, "a.txt", "snapshot\n");
    const snapshot = yield* service.snapshotWorkingTree(cwd, "old-head");
    yield* git(cwd, "checkout", "-q", "--", "a.txt");
    const head = yield* commit(cwd, "b.txt", "b\n");
    yield* write(cwd, "a.txt", "local\n");
    const before = yield* repoState(cwd);

    const error = yield* service
      .applySnapshot(cwd, snapshot, { safetySnapshotId: "never" })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "SnapshotParentMismatchError");
    assert.strictEqual(error._tag === "SnapshotParentMismatchError" ? error.head : null, head);
    assert.deepStrictEqual(yield* repoState(cwd), before);
    assert.strictEqual(yield* git(cwd, "for-each-ref", "refs/t3/machines/snapshots/never"), "");
    assert.strictEqual(yield* read(cwd, "a.txt"), "local\n");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("lists the paths whose content or absence still matches a snapshot", () =>
  Effect.gen(function* () {
    const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
    const cwd = yield* makeDirtyRepo();
    const snapshot = yield* service.snapshotWorkingTree(cwd, "applied");
    yield* write(cwd, "tracked.txt", "edited since\n");
    yield* write(cwd, "gone.txt", "back\n");
    yield* write(cwd, "fresh.txt", "new since\n");
    const before = yield* repoState(cwd);

    const unchanged = yield* service.pathsUnchangedSince(cwd, snapshot, [
      "tracked.txt",
      "staged.txt",
      "gone.txt",
      UNICODE_PATH,
      "fresh.txt",
      "never.txt",
    ]);

    assert.deepStrictEqual(unchanged, ["staged.txt", UNICODE_PATH, "never.txt"]);
    assert.deepStrictEqual(yield* repoState(cwd), before);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

// The shared test setup turns core.filemode off for every git child; this case needs it on.
const layerFileMode = WorkingTreeSnapshot.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer),
  Layer.provideMerge(
    Layer.effect(
      VcsProcess.VcsProcess,
      Effect.gen(function* () {
        const vcsProcess = yield* VcsProcess.make;
        const inherited = yield* HostProcess.Environment;
        const platform = yield* HostProcess.Platform;
        return VcsProcess.VcsProcess.of({
          run: (input) =>
            vcsProcess.run({
              ...input,
              env: {
                ...input.env,
                ...VcsProcess.gitConfigEnv(
                  { ...inherited, ...input.env },
                  "core.filemode",
                  "true",
                  platform,
                ),
              },
            }),
        });
      }),
    ).pipe(Layer.provide(ProcessRunner.layer)),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "carries an executable-bit change through describe, snapshot, apply and restore",
  () =>
    Effect.gen(function* () {
      const service = yield* WorkingTreeSnapshot.WorkingTreeSnapshot;
      const source = yield* makeRepo({ "script.sh": "echo hi\n" });
      const destination = yield* cloneRepo(source);
      yield* chmod(source, "script.sh", 0o755);
      const blobId = (yield* git(source, "rev-parse", "HEAD:script.sh")).trim();
      const expected = [{ path: "script.sh", kind: "modified" as const, mode: "100755", blobId }];

      assert.deepStrictEqual((yield* service.describeCheckout(source)).entries, expected);
      const snapshot = yield* service.snapshotWorkingTree(source, "mode");
      assert.match(yield* git(source, "ls-tree", snapshot, "script.sh"), /^100755 /);

      yield* git(destination, "fetch", "-q", source, `${snapshot}:refs/t3/test/mode`);
      const { safetyCommit } = yield* service.applySnapshot(destination, snapshot, {
        safetySnapshotId: "mode-safety",
      });
      assert.deepStrictEqual((yield* service.describeCheckout(destination)).entries, expected);

      yield* service.applySnapshot(destination, safetyCommit, {
        safetySnapshotId: "mode-undo",
        replaces: snapshot,
      });
      assert.deepStrictEqual((yield* service.describeCheckout(destination)).entries, []);
    }).pipe(Effect.scoped, Effect.provide(layerFileMode)),
);
