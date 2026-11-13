// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { repositoryGroupingDisplayNameOf, repositoryGroupingKeyOf } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

// Windows forbids CR and LF in file names.
const lineBreakSuffixes = HostProcess.Platform.defaultValue() === "win32" ? [] : ["\r", "\n"];
const bareLayouts = [
  "bare clone",
  "dot-bare",
  ...lineBreakSuffixes.map((suffix) => `bare clone${suffix}`),
];

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const commit = (cwd: string, message: string) =>
  git(cwd, [
    "-c",
    "user.name=T3",
    "-c",
    "user.email=t3@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    message,
  ]);

/** A repository with history, and clones of it whose remotes point wherever a test says. */
const makeHistory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-repository-history-" });
  yield* git(source, ["init", "-q"]);
  yield* commit(source, "first");
  yield* commit(source, "second");
  const rootCommit = (yield* git(source, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim();
  const clone = (remotes: ReadonlyArray<readonly [string, string]>, cloneArgs: string[] = []) =>
    Effect.gen(function* () {
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-repository-clone-" });
      // A file URL, as a plain path ignores --depth.
      yield* git(source, ["clone", "-q", ...cloneArgs, NodeURL.pathToFileURL(source).href, cwd]);
      yield* git(cwd, ["remote", "remove", "origin"]);
      for (const [name, url] of remotes) yield* git(cwd, ["remote", "add", name, url]);
      // Set locally so a developer's global setting cannot change the outcome.
      yield* git(cwd, ["config", "t3code.groupByHistory", "true"]);
      return cwd;
    });
  return { rootCommit, clone };
});

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath matches git's long paths when Windows temp dirs use 8.3 names.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
      expect(yield* resolver.resolve(path.join(cwd, ".git"))).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("identifies the host of an SSH remote that leaves its user to ssh config", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-userless-remote-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.displayName).toBe("T3Tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("keys a remote behind an SSH host alias by the host ssh config resolves it to", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const aliasDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-ssh-alias-test-",
      });
      const plainDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-ssh-plain-test-",
      });

      yield* git(aliasDir, ["init"]);
      yield* git(aliasDir, ["remote", "add", "origin", "git@github.com-personal:owner/repo.git"]);
      yield* git(plainDir, ["init"]);
      yield* git(plainDir, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

      const runner = yield* ProcessRunner.ProcessRunner;
      // Stands in for `Host github.com-personal` / `HostName github.com` in ~/.ssh/config.
      const resolver = yield* RepositoryIdentityResolver.make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) =>
            input.command === "ssh" && input.args.includes("-G")
              ? Effect.succeed({
                  stdout: input.args.some((arg) => arg.includes("github.com-personal"))
                    ? "user git\nhostname github.com\nport 22\n"
                    : `hostname ${input.args.at(-1) ?? ""}\nport 22\n`,
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                })
              : runner.run(input),
        }),
      );

      const aliasIdentity = yield* resolver.resolve(aliasDir);
      const plainIdentity = yield* resolver.resolve(plainDir);

      expect(plainIdentity?.canonicalKey).toBe("github.com/owner/repo");
      expect(aliasIdentity?.canonicalKey).toBe(plainIdentity?.canonicalKey);
      expect(aliasIdentity?.locator.remoteUrl).toBe("git@github.com-personal:owner/repo.git");
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("keeps a literal .git in an Azure DevOps repository name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-azure-git-suffix-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, [
        "remote",
        "add",
        "origin",
        "https://dev.azure.com/Acme/Platform/_git/Tool.git",
      ]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.displayName).toBe("Acme/Platform/_git/Tool.git");
      expect(identity?.name).toBe("Tool.git");
      expect(sourceControlDefinitions.repositorySelector(identity)).toBe("Tool.git");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("resolves the fetch remote of a partial clone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-partial-clone-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", "git@github.com:T3Tools/push.git"]);
      yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

      const remotes = yield* git(cwd, ["remote", "-v"]);
      expect(remotes.stdout).toContain("(fetch) [blob:none]");

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.locator.remoteUrl).toBe("git@github.com:T3Tools/t3code.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("resolves a remote whose URL contains a space", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-spaced-url-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "ssh://git@git.example.test/team repos/app.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.locator.remoteUrl).toBe("ssh://git@git.example.test/team repos/app.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["repo", "repo ", ...lineBreakSuffixes.map((suffix) => `repo${suffix}`)])(
    "returns the git top-level root path when resolving from a nested workspace in %j",
    (rootName) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-nested-root-test-",
        });
        const repoRoot = path.join(tempDir, rootName);
        const nestedWorkspace = path.join(repoRoot, "packages", "web");

        yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
        yield* git(repoRoot, ["init"]);
        yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const identity = yield* resolver.resolve(nestedWorkspace);
        const resolvedIdentityRoot =
          identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
        const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

        expect(identity).not.toBeNull();
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
          normalizeResolvedPath(resolvedRepoRoot),
        );
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(bareLayouts)(
    "resolves a %j to its Git directory and the same identity as a checkout",
    (layout) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkout = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-checkout-",
        });
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-bare-",
        });
        const root = path.join(parent, layout);
        yield* fileSystem.makeDirectory(root);
        const bareGitDir = layout === "dot-bare" ? path.join(root, ".bare") : root;

        yield* git(checkout, ["init"]);
        yield* git(checkout, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
        yield* git(root, ["init", "--bare", bareGitDir]);
        if (layout === "dot-bare") {
          yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: ./.bare\n");
        }
        yield* git(root, [
          "--git-dir",
          bareGitDir,
          "remote",
          "add",
          "origin",
          "https://github.com/T3Tools/t3code.git",
        ]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const checkoutIdentity = yield* resolver.resolve(checkout);
        expect(checkoutIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        const resolvedBareGitDir = NodeFS.realpathSync.native(bareGitDir);
        const projectRoots = layout === "dot-bare" ? [root, bareGitDir] : [root];

        for (const projectRoot of projectRoots) {
          const identity = yield* resolver.resolve(projectRoot);
          const resolvedIdentityRoot =
            identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);

          expect(identity).not.toBeNull();
          expect(identity?.canonicalKey).toBe(checkoutIdentity?.canonicalKey);
          expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
            normalizeResolvedPath(resolvedBareGitDir),
          );
        }

        yield* git(root, ["--git-dir", bareGitDir, "remote", "remove", "origin"]);
        for (const projectRoot of projectRoots) {
          expect(yield* resolver.resolve(projectRoot, { refresh: true })).toBeNull();
        }
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "returns null for non-git, missing and no-remote folders, probing only what can exist",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-non-git-",
        });
        const gitDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-no-remote-",
        });

        yield* git(gitDir, ["init"]);

        const runner = yield* ProcessRunner.ProcessRunner;
        const runs: Array<ReadonlyArray<string>> = [];
        const resolver = yield* RepositoryIdentityResolver.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.suspend(() => {
                runs.push(input.args);
                return runner.run(input);
              }),
          }),
        );
        const bareProbes = () =>
          runs.filter((args) => args.some((arg) => arg.startsWith("--git-dir=")));

        expect(yield* resolver.resolve(path.join(nonGitDir, "deleted"))).toBeNull();
        expect(runs).toEqual([]);

        expect(yield* resolver.resolve(nonGitDir)).toBeNull();
        expect(bareProbes()).toEqual([]);

        expect(yield* resolver.resolve(gitDir)).toBeNull();
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("ignores local-path remotes such as GitButler's gb-local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const localOnlyDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-local-remote-",
      });
      const mixedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-mixed-remote-",
      });

      yield* git(localOnlyDir, ["init"]);
      yield* git(localOnlyDir, ["remote", "add", "gb-local", "."]);
      yield* git(localOnlyDir, ["remote", "add", "backup", "/srv/git/repo.git"]);
      yield* git(localOnlyDir, ["remote", "add", "archive", "file:///srv/git/repo.git"]);
      yield* git(mixedDir, ["init"]);
      yield* git(mixedDir, ["remote", "add", "gb-local", "."]);
      yield* git(mixedDir, ["remote", "add", "mirror", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(localOnlyDir)).toBeNull();

      const mixedIdentity = yield* resolver.resolve(mixedDir);
      expect(mixedIdentity?.locator.remoteName).toBe("mirror");
      expect(mixedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("T3Tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/julius/t3code-fork",
        remoteUrl: "git@github.com:julius/t3code-fork.git",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the fork as the identity when gh repo set-default points at it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-gh-default-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["config", "remote.origin.gh-resolved", "base"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/julius/t3code-fork");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("follows an OWNER/REPO mark only to a remote that fetches that repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-gh-parent-test-",
      });
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const resolveFresh = () => resolver.resolve(cwd, { refresh: true });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "fork", "https://github.com/julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "main", "https://github.com/T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "https://github.com/other/t3code.git"]);
      yield* git(cwd, ["config", "remote.fork.gh-resolved", "t3tools/t3code"]);
      const parent = yield* resolveFresh();
      expect(parent?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(parent?.locator).toEqual({
        source: "git-remote",
        remoteName: "main",
        remoteUrl: "https://github.com/T3Tools/t3code.git",
      });

      // No remote fetches the marked repository, and several marks leave gh's choice unknown.
      yield* git(cwd, ["config", "remote.fork.gh-resolved", "someone/else"]);
      expect((yield* resolveFresh())?.locator.remoteName).toBe("upstream");
      yield* git(cwd, ["config", "remote.fork.gh-resolved", "base"]);
      yield* git(cwd, ["config", "remote.main.gh-resolved", "base"]);
      expect((yield* resolveFresh())?.locator.remoteName).toBe("upstream");

      // The same path on another HTTPS port is a different server.
      yield* git(cwd, ["config", "--unset", "remote.fork.gh-resolved"]);
      yield* git(cwd, ["config", "--unset", "remote.main.gh-resolved"]);
      yield* git(cwd, ["remote", "add", "backup", "https://ghe.example.com:9443/acme/web.git"]);
      yield* git(cwd, ["remote", "add", "ghe-fork", "https://ghe.example.com:8443/me/web.git"]);
      yield* git(cwd, ["remote", "add", "ghe-parent", "https://ghe.example.com:8443/acme/web.git"]);
      yield* git(cwd, ["config", "remote.ghe-fork.gh-resolved", "acme/web"]);
      expect((yield* resolveFresh())?.locator.remoteName).toBe("ghe-parent");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reads the project's gh default when the server inherited GIT_DIR", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-gh-default-git-dir-",
      });
      const other = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-inherited-git-dir-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["config", "remote.origin.gh-resolved", "base"]);
      yield* git(other, ["init"]);
      yield* git(other, ["config", "remote.upstream.gh-resolved", "base"]);

      vi.stubEnv("GIT_DIR", path.join(other, ".git"));
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/julius/t3code-fork");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("T3Tools/platform/t3code");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("groups clones of one repository fetched through different remotes by history", () =>
    Effect.gen(function* () {
      const { rootCommit, clone } = yield* makeHistory;
      const team = "git@github.com:theholycows/1538_2026_Offseason_Rust.git";
      const personal = "git@github.com:ssemtner/1538_2026_Offseason_Rust.git";
      const laptop = yield* clone([
        ["personal", personal],
        ["origin", team],
      ]);
      const desktop = yield* clone([["origin", personal]]);
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

      yield* git(laptop, ["config", "t3code.groupByHistory", "false"]);
      const remoteGrouped = yield* resolver.resolve(laptop);
      expect(remoteGrouped?.origin).toBeUndefined();

      yield* git(laptop, ["config", "t3code.groupByHistory", "true"]);
      const laptopIdentity = yield* resolver.resolve(laptop, { refresh: true });
      const desktopIdentity = yield* resolver.resolve(desktop);
      expect(laptopIdentity).toEqual({ ...remoteGrouped, origin: laptopIdentity?.origin });
      expect(laptopIdentity?.canonicalKey).toBe("github.com/theholycows/1538_2026_offseason_rust");
      expect(laptopIdentity?.locator.remoteUrl).toBe(team);
      expect(desktopIdentity?.canonicalKey).toBe("github.com/ssemtner/1538_2026_offseason_rust");
      expect(desktopIdentity?.owner).toBe("ssemtner");
      expect(desktopIdentity?.name).toBe("1538_2026_Offseason_Rust");
      expect(repositoryGroupingKeyOf(laptopIdentity!)).toBe(`git-root:${rootCommit}`);
      expect(repositoryGroupingKeyOf(desktopIdentity!)).toBe(`git-root:${rootCommit}`);
      expect(repositoryGroupingDisplayNameOf(laptopIdentity!)).toBe(
        "theholycows/1538_2026_Offseason_Rust",
      );
      expect(repositoryGroupingDisplayNameOf(desktopIdentity!)).toBe(
        "ssemtner/1538_2026_Offseason_Rust",
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("keeps a fork's own origin as the clone source when grouping by history", () =>
    Effect.gen(function* () {
      const { rootCommit, clone } = yield* makeHistory;
      const cwd = yield* clone([
        ["origin", "git@github.com:julius/t3code-fork.git"],
        ["upstream", "git@github.com:T3Tools/t3code.git"],
      ]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: `git-root:${rootCommit}`,
        remoteUrl: "git@github.com:julius/t3code-fork.git",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("groups by the mainline root when another history was merged in", () =>
    Effect.gen(function* () {
      const { rootCommit, clone } = yield* makeHistory;
      const remotes = [["origin", "git@github.com:T3Tools/t3code.git"]] as const;
      const merged = yield* clone(remotes);
      const plain = yield* clone(remotes);
      const branch = (yield* git(merged, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
      yield* git(merged, ["checkout", "-q", "--orphan", "imported"]);
      yield* commit(merged, "imported root");
      yield* git(merged, ["checkout", "-q", branch]);
      yield* git(merged, [
        "-c",
        "user.name=T3",
        "-c",
        "user.email=t3@example.test",
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-edit",
        "--allow-unrelated-histories",
        "imported",
      ]);
      const roots = yield* git(merged, ["rev-list", "--max-parents=0", "HEAD"]);
      expect(roots.stdout.trim().split("\n")).toHaveLength(2);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect((yield* resolver.resolve(merged))?.origin?.canonicalKey).toBe(
        `git-root:${rootCommit}`,
      );
      expect((yield* resolver.resolve(plain))?.origin?.canonicalKey).toBe(`git-root:${rootCommit}`);
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("keeps grouping by remote for a shallow clone, whose root is unknown", () =>
    Effect.gen(function* () {
      const { clone } = yield* makeHistory;
      const cwd = yield* clone([["origin", "git@github.com:T3Tools/t3code.git"]], ["--depth", "1"]);
      expect((yield* git(cwd, ["rev-parse", "--is-shallow-repository"])).stdout.trim()).toBe(
        "true",
      );

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.origin).toBeUndefined();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
