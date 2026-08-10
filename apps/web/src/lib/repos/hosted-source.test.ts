import { describe, expect, it, vi } from "vitest";
import type { GitProvider } from "@/lib/git/provider";
import type { CommitSummary, Page, TreeEntry } from "@/lib/git/types";
import { hostedCommits, hostedContents, hostedFileContent, type HostedRepo } from "./hosted-source";

function repo(git: Partial<GitProvider>): HostedRepo {
	return {
		ref: { owner: "adam", repo: "hello" },
		git: git as GitProvider,
		defaultBranch: "main",
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
	it("decodes text and leaves binary bodies empty", async () => {
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
		expect(binary?.content).toBe("");
	});

	it("is null for a path the backend does not have", async () => {
		const hosted = repo({ getFileContent: vi.fn().mockResolvedValue(null) });
		expect(await hostedFileContent(hosted, "nope.txt")).toBeNull();
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
