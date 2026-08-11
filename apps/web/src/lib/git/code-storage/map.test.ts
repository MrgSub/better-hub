import { describe, expect, it } from "vitest";
import {
	toBlameHunks,
	toFileDiffs,
	toFileStatus,
	toGrepMatches,
	toMergeConflicts,
	toMergeStatus,
	toPage,
	toRepo,
	type WireBlameLine,
	type WireMergePreview,
	type WireRepo,
} from "./map";

function blameLine(overrides: Partial<WireBlameLine>): WireBlameLine {
	return {
		commit_sha: "a".repeat(40),
		line_number: 1,
		author_name: "Jane",
		author_email: "jane@example.com",
		author_time: "2024-01-15T14:32:18Z",
		summary: "init",
		...overrides,
	};
}

describe("toRepo", () => {
	const wire: WireRepo = {
		repo_id: "repo_7f2b3d9",
		url: "team/project-alpha",
		default_branch: "main",
		created_at: "2024-01-15T10:30:00Z",
	};

	it("splits owner and name out of the repo url", () => {
		expect(toRepo(wire)).toEqual({
			id: "repo_7f2b3d9",
			owner: "team",
			name: "project-alpha",
			defaultBranch: "main",
			createdAt: "2024-01-15T10:30:00Z",
			upstream: null,
		});
	});

	it("keeps slashes that belong to the repo name", () => {
		expect(toRepo({ ...wire, url: "team/group/project" }).name).toBe("group/project");
	});

	it("normalizes an unknown upstream provider", () => {
		const upstream = toRepo({
			...wire,
			base_repo: { provider: "codeberg", owner: "octocat", name: "Hello-World" },
		}).upstream;
		expect(upstream).toEqual({
			provider: "generic",
			owner: "octocat",
			name: "Hello-World",
		});
	});
});

describe("toPage", () => {
	it("maps items and carries pagination state", () => {
		const page = toPage(
			{ has_more: true, next_cursor: "c1" },
			[{ name: "v1" }],
			(tag) => tag.name,
		);
		expect(page).toEqual({ items: ["v1"], nextCursor: "c1", hasMore: true });
	});

	it("treats a missing collection as an empty last page", () => {
		expect(toPage(null, null, (item: never) => item)).toEqual({
			items: [],
			nextCursor: null,
			hasMore: false,
		});
	});
});

describe("toFileStatus", () => {
	it("keeps git status letters", () => {
		expect(toFileStatus("A")).toBe("A");
		expect(toFileStatus("D")).toBe("D");
	});

	it("strips the similarity score from a rename", () => {
		expect(toFileStatus("R096")).toBe("R");
	});

	it("falls back to modified for anything unrecognized", () => {
		expect(toFileStatus("X")).toBe("M");
	});
});

describe("toFileDiffs", () => {
	it("marks server-filtered files as truncated and keeps them in the list", () => {
		const diffs = toFileDiffs({
			files: [
				{
					path: "src/main.go",
					state: "M",
					raw: "diff",
					bytes: 10,
					is_eof: true,
				},
			],
			filtered_files: [
				{
					path: "package-lock.json",
					state: "M",
					bytes: 50000,
					is_eof: true,
				},
			],
		});
		expect(diffs).toEqual([
			{
				path: "src/main.go",
				status: "M",
				patch: "diff",
				truncated: false,
				bytes: 10,
			},
			{
				path: "package-lock.json",
				status: "M",
				patch: null,
				truncated: true,
				bytes: 50000,
			},
		]);
	});

	it("returns nothing for an absent diff", () => {
		expect(toFileDiffs(null)).toEqual([]);
	});
});

describe("toBlameHunks", () => {
	it("collapses consecutive lines from the same commit", () => {
		const hunks = toBlameHunks("src/main.go", [
			blameLine({ line_number: 1 }),
			blameLine({ line_number: 2 }),
			blameLine({ line_number: 3, commit_sha: "b".repeat(40) }),
			blameLine({ line_number: 4 }),
		]);
		expect(hunks.map((hunk) => [hunk.startLine, hunk.endLine])).toEqual([
			[1, 2],
			[3, 3],
			[4, 4],
		]);
	});

	it("does not merge across a line gap", () => {
		const hunks = toBlameHunks("src/main.go", [
			blameLine({ line_number: 1 }),
			blameLine({ line_number: 5 }),
		]);
		expect(hunks).toHaveLength(2);
	});
});

describe("toGrepMatches", () => {
	it("flattens matches and drops context lines", () => {
		expect(
			toGrepMatches([
				{
					path: "a.md",
					lines: [
						{ line_number: 1, text: "before", type: "context" },
						{ line_number: 2, text: "hit", type: "match" },
					],
				},
			]),
		).toEqual([{ path: "a.md", lineNumber: 2, line: "hit" }]);
	});

	it("still reports a file whose match lines were withheld", () => {
		expect(toGrepMatches([{ path: "a.md", lines: [] }])).toEqual([
			{ path: "a.md", lineNumber: null, line: null },
		]);
	});
});

describe("merge preview mapping", () => {
	const preview: WireMergePreview = {
		status: "conflicted",
		result: "merge_commit",
		source_tip_sha: "9eb",
		target_tip_sha: "c4f",
		merge_base_sha: "a2d",
		conflict_paths: ["docs/conflict.txt", "src/app.ts"],
		conflicts: [
			{
				path: "docs/conflict.txt",
				ours: { content: "ours", binary: false, truncated: false },
			},
		],
	};

	it("keeps conflicts whose content the server withheld", () => {
		expect(toMergeConflicts(preview)).toEqual([
			{ path: "docs/conflict.txt", content: "ours" },
			{ path: "src/app.ts", content: null },
		]);
	});

	it("distinguishes a no-op merge from a clean one", () => {
		expect(toMergeStatus(preview)).toBe("conflicted");
		expect(toMergeStatus({ ...preview, status: "clean" })).toBe("clean");
		expect(toMergeStatus({ ...preview, status: "clean", result: "no_op" })).toBe(
			"up_to_date",
		);
	});
});
