import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitProvider } from "./provider";
import type { RepoRef } from "./types";

const AUTHOR = { name: "Better Hub Contract", email: "contract@better-hub.com" };

function text(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/**
 * The behaviour every adapter must exhibit, run once per backend.
 *
 * It provisions a throwaway repository, so it only runs where the backend is
 * configured — see the `skipIf` guards in `contract.test.ts`.
 */
export function runGitProviderContract(name: string, make: () => GitProvider): void {
	describe(`GitProvider contract: ${name}`, () => {
		const repo: RepoRef = {
			owner: "better-hub-contract",
			repo: `t${Date.now().toString(36)}`,
		};
		// Built in `beforeAll` so a skipped suite never constructs an adapter,
		// which would throw on the missing backend credentials at collection time.
		let git!: GitProvider;
		let firstSha = "";

		beforeAll(async () => {
			git = make();
			await git.createRepo(repo, { defaultBranch: "main" });
		});

		afterAll(async () => {
			await git.deleteRepo(repo);
		});

		it("reports the repository it just created", async () => {
			const info = await git.getRepo(repo);
			expect(info).not.toBeNull();
			expect(info?.owner).toBe(repo.owner);
			expect(info?.name).toBe(repo.repo);
			expect(info?.defaultBranch).toBe("main");
		});

		it("returns null for a repository that does not exist", async () => {
			expect(
				await git.getRepo({
					owner: repo.owner,
					repo: "definitely-missing",
				}),
			).toBeNull();
		});

		it("treats an empty repository as empty rather than missing", async () => {
			const branches = await git.listBranches(repo);
			expect(branches.items).toEqual([]);
			expect(branches.hasMore).toBe(false);
			expect((await git.listCommits(repo)).items).toEqual([]);
			expect(await git.listFiles(repo, "main")).toEqual([]);
		});

		it("commits files and reads them back", async () => {
			const commit = await git.commitFiles(repo, {
				branch: "main",
				message: "feat: add readme",
				author: AUTHOR,
				files: [
					{ path: "README.md", content: "# contract\n" },
					{
						path: "src/app.ts",
						content: "export const value = 1;\n",
					},
				],
			});
			firstSha = commit.sha;
			expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);

			const blob = await git.getFileContent(repo, "README.md", "main");
			expect(blob).not.toBeNull();
			expect(text(blob!.content)).toBe("# contract\n");
			expect(blob?.binary).toBe(false);

			const files = await git.listFiles(repo, "main", { recursive: true });
			expect(files.map((entry) => entry.path).sort()).toEqual([
				"README.md",
				"src/app.ts",
			]);
			expect(files.every((entry) => entry.type === "blob")).toBe(true);
		});

		it("returns null for a file that does not exist", async () => {
			expect(await git.getFileContent(repo, "nope.md", "main")).toBeNull();
		});

		it("lists commits newest-first with canonical fields", async () => {
			const page = await git.listCommits(repo, { branch: "main" });
			expect(page.items).toHaveLength(1);
			const [commit] = page.items;
			expect(commit.sha).toBe(firstSha);
			expect(commit.message).toContain("feat: add readme");
			expect(commit.parents).toEqual([]);
			expect(commit.author.email).toBe(AUTHOR.email);
			expect(Number.isNaN(Date.parse(commit.date))).toBe(false);
		});

		it("reads a single commit and its diff", async () => {
			const detail = await git.getCommit(repo, firstSha);
			expect(detail?.sha).toBe(firstSha);

			const diff = await git.getCommitDiff(repo, firstSha);
			expect(diff.map((file) => file.path).sort()).toEqual([
				"README.md",
				"src/app.ts",
			]);
			expect(diff.every((file) => file.status === "A")).toBe(true);
		});

		it("branches, commits on the branch, and compares against the base", async () => {
			await git.createBranch(repo, "feature", "main");
			expect(
				(await git.listBranches(repo)).items.map((b) => b.name).sort(),
			).toEqual(["feature", "main"]);

			await git.commitFiles(repo, {
				branch: "feature",
				message: "feat: change app",
				author: AUTHOR,
				files: [
					{
						path: "src/app.ts",
						content: "export const value = 2;\n",
					},
				],
			});

			const comparison = await git.compare(repo, "main", "feature");
			expect(comparison.files.map((file) => file.path)).toEqual(["src/app.ts"]);
			expect(comparison.files[0]?.status).toBe("M");
			expect(comparison.stats.files).toBeGreaterThan(0);
		});

		it("previews a clean merge and performs it", async () => {
			const preview = await git.previewMerge(repo, "main", "feature");
			expect(preview.status).toBe("clean");
			expect(preview.conflicts).toEqual([]);

			const result = await git.merge(repo, "main", "feature", {
				author: AUTHOR,
				message: "merge feature",
			});
			expect(result.merged).toBe(true);
			expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

			const blob = await git.getFileContent(repo, "src/app.ts", "main");
			expect(text(blob!.content)).toBe("export const value = 2;\n");
		});

		it("reports conflicts instead of merging them", async () => {
			await git.createBranch(repo, "left", "main");
			await git.createBranch(repo, "right", "main");
			await git.commitFiles(repo, {
				branch: "left",
				message: "left",
				author: AUTHOR,
				files: [{ path: "conflict.txt", content: "left\n" }],
			});
			await git.commitFiles(repo, {
				branch: "right",
				message: "right",
				author: AUTHOR,
				files: [{ path: "conflict.txt", content: "right\n" }],
			});
			await git.merge(repo, "main", "left", { author: AUTHOR });

			const preview = await git.previewMerge(repo, "main", "right");
			expect(preview.status).toBe("conflicted");
			expect(preview.conflicts.map((conflict) => conflict.path)).toEqual([
				"conflict.txt",
			]);

			const result = await git.merge(repo, "main", "right", { author: AUTHOR });
			expect(result.merged).toBe(false);
			expect(result.status).toBe("conflicted");
			expect(result.conflicts.map((conflict) => conflict.path)).toEqual([
				"conflict.txt",
			]);
		});

		it("deletes a branch", async () => {
			await git.deleteBranch(repo, "left");
			expect(
				(await git.listBranches(repo)).items.map((b) => b.name),
			).not.toContain("left");
		});

		it("tags a commit and lists it", async () => {
			await git.createTag(repo, "v1.0.0", firstSha);
			const tags = await git.listTags(repo);
			expect(tags.items.map((tag) => tag.name)).toContain("v1.0.0");
		});

		it("deletes a file through a commit", async () => {
			await git.commitFiles(repo, {
				branch: "main",
				message: "chore: drop readme",
				author: AUTHOR,
				files: [{ path: "README.md", deleted: true }],
			});
			expect(await git.getFileContent(repo, "README.md", "main")).toBeNull();
		});

		it("blames a file", async () => {
			const hunks = await git.getBlame(repo, "src/app.ts", "main");
			expect(hunks.length).toBeGreaterThan(0);
			expect(hunks[0]?.path).toBe("src/app.ts");
			expect(hunks[0]?.startLine).toBe(1);
			expect(hunks[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
		});

		it("greps tracked content", async () => {
			const page = await git.grep(repo, "export const", { ref: "main" });
			expect(page.items.map((match) => match.path)).toContain("src/app.ts");
		});

		it("lists tree entries with their last commit", async () => {
			const entries = await git.listFilesWithMetadata(repo, "main");
			expect(entries.length).toBeGreaterThan(0);
			expect(entries.some((entry) => entry.lastCommitSha !== null)).toBe(true);
		});

		it("streams an archive", async () => {
			const stream = await git.getArchiveStream(repo, "main");
			const reader = stream.getReader();
			const first = await reader.read();
			await reader.cancel();
			expect(first.value?.byteLength).toBeGreaterThan(0);
		});

		it("mints a remote url that carries credentials but not the org key", async () => {
			const url = await git.getRemoteUrl(repo, ["read"], 60);
			expect(url.startsWith("https://")).toBe(true);
			expect(url).toContain(`${repo.owner}/${repo.repo}`);
			expect(url).not.toContain("PRIVATE KEY");
		});

		it("imports a public upstream repository, history included", async () => {
			const imported: RepoRef = {
				owner: repo.owner,
				repo: `${repo.repo}-import`,
			};
			try {
				await git.createRepo(imported, {
					defaultBranch: "master",
					baseRepo: {
						provider: "github",
						owner: "octocat",
						name: "Hello-World",
					},
				});

				// The upstream clone runs asynchronously behind the create call.
				let names: string[] = [];
				for (let i = 0; i < 20 && !names.includes("master"); i++) {
					await new Promise((resolve) => setTimeout(resolve, 3000));
					names = await git
						.listBranches(imported)
						.then((page) => page.items.map((b) => b.name))
						.catch(() => []);
				}
				expect(names).toContain("master");

				const readme = await git.getFileContent(
					imported,
					"README",
					"master",
				);
				expect(new TextDecoder().decode(readme?.content)).toContain(
					"Hello World",
				);
			} finally {
				await git.deleteRepo(imported);
			}
		});
	});
}
