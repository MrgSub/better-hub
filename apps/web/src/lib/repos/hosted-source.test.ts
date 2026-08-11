import { describe, expect, it, vi } from "vitest";
import type { Repository } from "@/generated/prisma/client";
import type { GitProvider } from "@/lib/git/provider";
import type { CommitSummary, Page, TreeEntry } from "@/lib/git/types";

vi.mock("@/lib/db", () => ({
	prisma: {
		repository: {
			count: vi.fn().mockResolvedValue(0),
			findUnique: vi.fn().mockResolvedValue(null),
			findFirst: vi.fn().mockResolvedValue(null),
		},
		repositoryCollaborator: { findUnique: vi.fn().mockResolvedValue(null) },
		organizationMember: { findUnique: vi.fn().mockResolvedValue(null) },
	},
}));
vi.mock("./viewer", () => ({ viewerId: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/git", () => ({ getGitProvider: vi.fn(() => ({}) as GitProvider) }));

import { prisma } from "@/lib/db";
import {
	hostedCommit,
	hostedCommits,
	hostedContents,
	hostedFileContent,
	hostedReadme,
	hostedRepo,
	hostedRepoData,
	type HostedRepo,
} from "./hosted-source";
import { viewerId } from "./viewer";
import { providerRef } from "./registry";

function record(overrides: Partial<Repository> = {}): Repository {
	return {
		id: "repo_1",
		owner: "adam",
		name: "hello",
		defaultBranch: "main",
		gitBackend: "code-storage",
		gitRepoId: "adam/hello",
		description: null,
		homepage: null,
		topics: [],
		isPrivate: false,
		archived: false,
		sizeKb: 0,
		stars: 0,
		watchers: 0,
		openIssues: 0,
		language: null,
		licenseName: null,
		licenseSpdx: null,
		languagesJson: null,
		metadataSyncedAt: null,
		upstreamHost: null,
		upstreamOwner: null,
		upstreamName: null,
		forkOfId: null,
		ownerUserId: "user_1",
		organizationId: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-02T00:00:00.000Z"),
		...overrides,
	} as Repository;
}

function repo(git: Partial<GitProvider>, row: Repository = record()): HostedRepo {
	return {
		ref: { owner: "adam", repo: "hello" },
		git: {
			backend: "code-storage",
			mergeStrategies: ["merge", "squash", "fast_forward"],
			...git,
		} as GitProvider,
		defaultBranch: "main",
		record: row,
	};
}

function commit(sha: string): CommitSummary {
	return {
		sha,
		message: `commit ${sha}`,
		parents: [],
		author: { name: "Adam", email: "adam@example.com" },
		committer: { name: "Adam", email: "adam@example.com" },
		date: "2026-01-01T00:00:00Z",
	};
}

describe("hostedContents", () => {
	it("names directories the way the file list expects", async () => {
		const entries: TreeEntry[] = [
			{ path: "src", type: "tree", mode: "040000", size: null },
			{ path: "src/app.ts", type: "blob", mode: "100644", size: 12 },
		];
		const listFiles = vi.fn().mockResolvedValue(entries);

		const contents = await hostedContents(repo({ listFiles }), "src");

		expect(listFiles).toHaveBeenCalledWith({ owner: "adam", repo: "hello" }, "main", {
			path: "src",
		});
		expect(contents).toEqual([
			expect.objectContaining({ name: "src", path: "src", type: "dir", size: 0 }),
			expect.objectContaining({
				name: "app.ts",
				path: "src/app.ts",
				type: "file",
				size: 12,
			}),
		]);
	});
});

describe("hostedFileContent", () => {
	it("decodes text and keeps binary control bytes for the viewer's sniff", async () => {
		const text = await hostedFileContent(
			repo({
				getFileContent: vi.fn().mockResolvedValue({
					path: "a.txt",
					ref: "main",
					content: new TextEncoder().encode("hello"),
					size: 5,
					binary: false,
				}),
			}),
			"a.txt",
		);
		expect(text?.content).toBe("hello");

		const binary = await hostedFileContent(
			repo({
				getFileContent: vi.fn().mockResolvedValue({
					path: "a.png",
					ref: "main",
					content: new Uint8Array([0, 1, 2]),
					size: 3,
					binary: true,
				}),
			}),
			"a.png",
		);
		// eslint-disable-next-line no-control-regex
		expect(binary?.content).toMatch(/[\x00-\x08]/);
	});

	it("is null for a path the backend does not have", async () => {
		const hosted = repo({ getFileContent: vi.fn().mockResolvedValue(null) });
		expect(await hostedFileContent(hosted, "nope.txt")).toBeNull();
	});

	it("is null for a directory rather than asking the backend", async () => {
		const getFileContent = vi.fn();
		expect(await hostedFileContent(repo({ getFileContent }), "")).toBeNull();
		expect(getFileContent).not.toHaveBeenCalled();
	});
});

describe("hostedRepoData", () => {
	const head = { items: [commit("head")], nextCursor: null, hasMore: false };

	it("describes the repository from our own record", async () => {
		const data = await hostedRepoData(
			repo(
				{ listCommits: vi.fn().mockResolvedValue(head) },
				record({
					description: "hosted here",
					topics: ["git"],
					isPrivate: true,
					upstreamHost: "github.com",
					upstreamOwner: "adam",
					upstreamName: "hello",
				}),
			),
			"write",
		);

		expect(data).toMatchObject({
			full_name: "adam/hello",
			description: "hosted here",
			topics: ["git"],
			private: true,
			default_branch: "main",
			html_url: "https://github.com/adam/hello",
			pushed_at: "2026-01-01T00:00:00Z",
			permissions: { admin: false, push: true, pull: true },
		});
	});

	it("surfaces the read-only data copied from the upstream", async () => {
		const data = await hostedRepoData(
			repo(
				{ listCommits: vi.fn().mockResolvedValue(head) },
				record({
					stars: 42,
					watchers: 7,
					openIssues: 3,
					language: "TypeScript",
					licenseName: "MIT License",
					licenseSpdx: "MIT",
				}),
			),
			"admin",
		);

		expect(data).toMatchObject({
			stargazers_count: 42,
			subscribers_count: 7,
			open_issues_count: 3,
			language: "TypeScript",
			license: { name: "MIT License", spdx_id: "MIT" },
		});
	});

	// `size === 0` is how the pages spot an empty repository.
	it("reports a size for a repository with commits but no recorded size", async () => {
		const withCommits = await hostedRepoData(
			repo({ listCommits: vi.fn().mockResolvedValue(head) }),
			"admin",
		);
		expect(withCommits.size).toBe(1);

		const empty = await hostedRepoData(
			repo({
				listCommits: vi.fn().mockResolvedValue({
					items: [],
					nextCursor: null,
					hasMore: false,
				}),
			}),
			"admin",
		);
		expect(empty.size).toBe(0);
	});
});

describe("hostedReadme", () => {
	it("reads the root readme through the backend", async () => {
		const entries: TreeEntry[] = [
			{ path: "src", type: "tree", mode: "040000", size: null },
			{ path: "Readme.md", type: "blob", mode: "100644", size: 3 },
		];
		const getFileContent = vi.fn().mockResolvedValue({
			path: "Readme.md",
			ref: "main",
			content: new TextEncoder().encode("hi"),
			size: 2,
			binary: false,
		});

		const readme = await hostedReadme(
			repo({ listFiles: vi.fn().mockResolvedValue(entries), getFileContent }),
		);

		expect(readme).toMatchObject({ path: "Readme.md", content: "hi" });
	});

	it("is null when the root has none", async () => {
		const hosted = repo({ listFiles: vi.fn().mockResolvedValue([]) });
		expect(await hostedReadme(hosted)).toBeNull();
	});
});

describe("hostedCommits", () => {
	it("walks cursors to reach a numbered page", async () => {
		const pages: Page<CommitSummary>[] = [
			{ items: [commit("a")], nextCursor: "c1", hasMore: true },
			{ items: [commit("b")], nextCursor: null, hasMore: false },
		];
		const listCommits = vi
			.fn()
			.mockImplementation(() => Promise.resolve(pages.shift()));

		const commits = await hostedCommits(repo({ listCommits }), "main", 2, 1);

		expect(listCommits).toHaveBeenNthCalledWith(2, expect.anything(), {
			branch: "main",
			limit: 1,
			cursor: "c1",
		});
		expect(commits.map((c) => c.sha)).toEqual(["b"]);
	});

	it("is empty past the last page rather than repeating one", async () => {
		const listCommits = vi.fn().mockResolvedValue({
			items: [commit("a")],
			nextCursor: null,
			hasMore: false,
		});

		expect(await hostedCommits(repo({ listCommits }), undefined, 3, 30)).toEqual([]);
	});
});

describe("hostedCommit", () => {
	const patch = ["@@ -1,2 +1,3 @@", " keep", "-gone", "+added", "+also"].join("\n");

	it("reads the commit and its diff from the backend, never GitHub", async () => {
		const getCommit = vi.fn().mockResolvedValue({ ...commit("abc"), stats: null });
		const getCommitDiff = vi
			.fn()
			.mockResolvedValue([
				{ path: "a.ts", status: "M", patch, truncated: false, bytes: 20 },
			]);

		const detail = await hostedCommit(repo({ getCommit, getCommitDiff }), "abc");

		expect(getCommit).toHaveBeenCalledWith(expect.anything(), "abc");
		expect(detail?.sha).toBe("abc");
		// Derived from the patch, because the backend reported no stats.
		expect(detail?.stats).toEqual({ total: 3, additions: 2, deletions: 1 });
		expect(detail?.files[0]).toMatchObject({
			filename: "a.ts",
			status: "modified",
			additions: 2,
			deletions: 1,
			changes: 3,
		});
	});

	it("prefers the backend's own stats over counting the patch", async () => {
		const detail = await hostedCommit(
			repo({
				getCommit: vi.fn().mockResolvedValue({
					...commit("abc"),
					stats: { files: 1, additions: 9, deletions: 4 },
				}),
				getCommitDiff: vi.fn().mockResolvedValue([
					{
						path: "a.ts",
						status: "M",
						patch,
						truncated: false,
						bytes: 20,
					},
				]),
			}),
			"abc",
		);
		expect(detail?.stats).toEqual({ total: 13, additions: 9, deletions: 4 });
	});

	it("is null for a sha the backend does not have, so the page can say so", async () => {
		const getCommitDiff = vi.fn();
		const detail = await hostedCommit(
			repo({ getCommit: vi.fn().mockResolvedValue(null), getCommitDiff }),
			"nope",
		);
		expect(detail).toBeNull();
		expect(getCommitDiff).not.toHaveBeenCalled();
	});
});

describe("providerRef", () => {
	it("addresses the backend by the id it assigned, not our display name", () => {
		// Display casing drifted after the import; the backend never saw it.
		const drifted = record({ owner: "Adam", name: "Hello", gitRepoId: "adam/hello" });
		expect(providerRef(drifted)).toEqual({ owner: "adam", repo: "hello" });
	});

	it("falls back to the display pair for a row written before ids were stored", () => {
		expect(providerRef(record({ gitRepoId: "" }))).toEqual({
			owner: "adam",
			repo: "hello",
		});
	});
});

describe("hostedRepo", () => {
	it("resolves a public repository for anyone", async () => {
		vi.mocked(prisma.repository.findFirst).mockResolvedValue(record());

		expect(await hostedRepo("adam", "hello")).not.toBeNull();
	});

	it("hides a private repository from someone with no access", async () => {
		vi.mocked(prisma.repository.findFirst).mockResolvedValue(
			record({ isPrivate: true, ownerUserId: "user_1" }),
		);
		vi.mocked(viewerId).mockResolvedValue("stranger");

		expect(await hostedRepo("adam", "hello")).toBeNull();
	});

	it("resolves a private repository for its owner", async () => {
		vi.mocked(prisma.repository.findFirst).mockResolvedValue(
			record({ isPrivate: true, ownerUserId: "user_1" }),
		);
		vi.mocked(viewerId).mockResolvedValue("user_1");

		expect(await hostedRepo("adam", "hello")).not.toBeNull();
	});
});
