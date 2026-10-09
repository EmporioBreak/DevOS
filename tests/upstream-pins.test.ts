import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { snapshot, verifySource } from "../scripts/devos-upstreams.mjs";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("upstream pin rejects edited bytes, untracked files, moved commits and unsafe key paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-upstream-pin-"));
  try {
    git(root, "init", "-q");
    await mkdir(join(root, "skills", "example"), { recursive: true });
    await writeFile(join(root, "LICENSE"), "MIT fixture\n");
    await writeFile(join(root, "skills", "example", "SKILL.md"), "# Example\n");
    git(root, "add", ".");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-qm", "fixture");
    const commit = git(root, "rev-parse", "HEAD");
    const digest = await snapshot(root);
    const manifest = {
      id: "superpowers", repository: "https://github.com/obra/superpowers.git",
      tag: "fixture", commit, license: "MIT",
      fileCount: digest.fileCount, snapshotSha256: digest.snapshotSha256,
      keyFiles: { "skills/example/SKILL.md": digest.hashes["skills/example/SKILL.md"]! },
    };
    assert.equal((await verifySource(manifest, root)).snapshotSha256, digest.snapshotSha256);

    await writeFile(join(root, "skills", "example", "SKILL.md"), "# Altered\n");
    await assert.rejects(verifySource(manifest, root), /modified/);
    git(root, "checkout", "-q", "--", "skills/example/SKILL.md");

    await writeFile(join(root, "skills", "example", "unexpected.md"), "Not pinned");
    await assert.rejects(verifySource(manifest, root), /modified/);
    await rm(join(root, "skills", "example", "unexpected.md"));

    await assert.rejects(verifySource({
      ...manifest, keyFiles: { "../unsafe": digest.hashes["LICENSE"]! },
    }, root), /Unsafe pinned upstream/);

    await writeFile(join(root, "more.md"), "new content");
    git(root, "add", ".");
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-qm", "move revision");
    await assert.rejects(verifySource(manifest, root), /revision mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upstream snapshots reject symlink-based path escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-upstream-symlink-"));
  try {
    git(root, "init", "-q");
    await symlink("/etc/hosts", join(root, "SKILL.md"));
    git(root, "add", ".");
    await assert.rejects(snapshot(root), /Non-regular upstream file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
