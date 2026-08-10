import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, Repository } from "@/generated/prisma/client";
import type { GitProvider } from "@/lib/git/provider";
import type { HostedRepo } from "@/lib/repos/hosted-source";

vi.mock("@/lib/db", () => ({
	prisma: {
		pullRequest: { findFirst: vi.fn(), update: vi.fn() },
	},
}));
vi.mock("@/lib/repos/registry", () => ({ repositoryPermission: vi.fn() }));
vi.mock("./conflicts", () => ({ hostedConflicts: vi.fn() }));

import { prisma } from "@/lib/db";
import { repositoryPermission } from "@/lib/repos/registry";
import { hostedConflicts } from "./conflicts";
import { type ConflictAgent, resolveHostedConflicts } from "./resolve";

const actor = { userId: "user_1", login: "adam", name: "Adam", avatarUrl: null };

const pull = {
	id: "pr_1",
	number: 7,
	repositoryId: "repo_1",
	title: "Add a thing",
	bodyMd: "",
	state: "open",
	headBranch: "feature",
	baseBranch: "main",
	headSha: "sha_feature",
} as PullRequest;

function hosted(previewAfter: "clean" | "conflicted") {
	const git = {
		commitFiles: vi.fn().mockResolvedValue({ sha: "sha_resolved" }),
		previewMerge: vi.fn().mockResolvedValue({
			status: previewAfter,
			mergeBaseSha: "sha_base",
			baseSha: "sha_main",
			headSha: "sha_resolved",
			conflicts:
				previewAfter === "clean"
					? []
					: [{ path: "src/a.ts", content: null }],
		}),
	};
	const repo: HostedRepo = {
		ref: { owner: "adam", repo: "hello" },
		defaultBranch: "main",
		record: { id: "repo_1" } as Repository,
		git: git as unknown as GitProvider,
	};
	return { repo, git };
}

function agent(files: { path: string; content: string }[]): ConflictAgent {
	return { name: "test-agent", resolve: vi.fn().mockResolvedValue(files) };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(repositoryPermission).mockResolvedValue("write");
	vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(pull);
	vi.mocked(prisma.pullRequest.update).mockResolvedValue(pull);
	vi.mocked(hostedConflicts).mockResolvedValue({
		mergeBaseSha: "sha_base",
		baseBranch: "main",
		headBranch: "feature",
		baseSha: "sha_main",
		headSha: "sha_feature",
		files: [
			{
				path: "src/a.ts",
				hunks: [
					{
						type: "conflict",
						baseLines: ["a"],
						headLines: ["b"],
						ancestorLines: [],
					},
				],
				hasConflicts: true,
				autoResolved: false,
			},
		],
	});
});

describe("resolveHostedConflicts", () => {
	it("commits the resolution on the tip it was computed from and records it", async () => {
		const { repo, git } = hosted("clean");

		const result = await resolveHostedConflicts(
			repo,
			actor,
			7,
			agent([{ path: "src/a.ts", content: "a\nb\n" }]),
		);

		expect(result).toMatchObject({
			ok: true,
			sha: "sha_resolved",
			agent: "test-agent",
		});
		expect(git.commitFiles).toHaveBeenCalledWith(
			repo.ref,
			expect.objectContaining({
				branch: "feature",
				expectedHeadSha: "sha_feature",
			}),
		);
		expect(prisma.pullRequest.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					headSha: "sha_resolved",
					events: {
						create: expect.objectContaining({
							kind: "conflict_resolved",
						}),
					},
				}),
			}),
		);
	});

	it("refuses a resolution the backend still cannot merge", async () => {
		const { repo } = hosted("conflicted");

		const result = await resolveHostedConflicts(
			repo,
			actor,
			7,
			agent([{ path: "src/a.ts", content: "a\nb\n" }]),
		);

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("src/a.ts"),
		});
	});

	it("never commits output that skipped a file, invented one, or kept a marker", async () => {
		const { repo, git } = hosted("clean");

		for (const [files, expected] of [
			[[], "unresolved"],
			[
				[
					{ path: "src/a.ts", content: "ok" },
					{ path: "src/z.ts", content: "nope" },
				],
				"not in conflict",
			],
			[[{ path: "src/a.ts", content: "<<<<<<< main\na\n" }], "conflict markers"],
		] as const) {
			const result = await resolveHostedConflicts(
				repo,
				actor,
				7,
				agent([...files]),
			);
			expect(result).toMatchObject({
				ok: false,
				error: expect.stringContaining(expected),
			});
		}
		expect(git.commitFiles).not.toHaveBeenCalled();
	});

	it("refuses a viewer who cannot write", async () => {
		const { repo, git } = hosted("clean");
		vi.mocked(repositoryPermission).mockResolvedValue("read");

		const result = await resolveHostedConflicts(repo, actor, 7, agent([]));

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("write access"),
		});
		expect(git.commitFiles).not.toHaveBeenCalled();
	});

	it("reports an agent failure instead of throwing", async () => {
		const { repo } = hosted("clean");
		const failing: ConflictAgent = {
			name: "test-agent",
			resolve: vi.fn().mockRejectedValue(new Error("model unavailable")),
		};

		expect(await resolveHostedConflicts(repo, actor, 7, failing)).toEqual({
			ok: false,
			error: "model unavailable",
		});
	});
});
