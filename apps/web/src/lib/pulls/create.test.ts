import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@/generated/prisma/client";
import type { GitProvider } from "@/lib/git/provider";
import type { HostedRepo } from "@/lib/repos/hosted-source";

vi.mock("@/lib/db", () => ({
	prisma: {
		repository: { update: vi.fn() },
		pullRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
	},
}));
vi.mock("@/lib/repos/registry", () => ({ repositoryPermission: vi.fn() }));

import { prisma } from "@/lib/db";
import { repositoryPermission } from "@/lib/repos/registry";
import { createHostedPull } from "./create";

const author = { userId: "user_1", login: "adam", name: "Adam", avatarUrl: null };

function hosted(branches: string[]): HostedRepo {
	return {
		ref: { owner: "adam", repo: "hello" },
		defaultBranch: "main",
		record: { id: "repo_1" } as Repository,
		git: {
			listBranches: vi.fn().mockResolvedValue({
				items: branches.map((name) => ({
					name,
					sha: `sha_${name}`,
					createdAt: null,
				})),
				nextCursor: null,
				hasMore: false,
			}),
			compare: vi.fn().mockResolvedValue({
				baseSha: "sha_main",
				headSha: "sha_feature",
				mergeBaseSha: "sha_main",
				files: [],
				stats: { files: 2, additions: 5, deletions: 1 },
			}),
		} as unknown as GitProvider,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(repositoryPermission).mockResolvedValue("write");
	vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(null);
	vi.mocked(prisma.repository.update).mockResolvedValue({ nextNumber: 8 } as Repository);
	vi.mocked(prisma.pullRequest.create).mockImplementation(
		// biome-ignore lint/suspicious/noExplicitAny: prisma's create arg is generic
		(async ({ data }: any) => data) as never,
	);
});

describe("createHostedPull", () => {
	it("takes the number the counter just handed out", async () => {
		const result = await createHostedPull(hosted(["main", "feature"]), author, {
			title: "Add a thing",
			head: "feature",
			base: "main",
		});

		expect(result).toMatchObject({
			ok: true,
			pullRequest: {
				number: 7,
				headSha: "sha_feature",
				baseSha: "sha_main",
				additions: 5,
				deletions: 1,
				changedFiles: 2,
				authorLogin: "adam",
			},
		});
	});

	it("refuses a viewer who cannot write", async () => {
		vi.mocked(repositoryPermission).mockResolvedValue("read");

		const result = await createHostedPull(hosted(["main", "feature"]), author, {
			title: "Add a thing",
			head: "feature",
			base: "main",
		});

		expect(result).toEqual({
			ok: false,
			error: expect.stringContaining("write access"),
		});
		expect(prisma.repository.update).not.toHaveBeenCalled();
	});

	it("refuses a branch the backend does not have, without burning a number", async () => {
		const result = await createHostedPull(hosted(["main"]), author, {
			title: "Add a thing",
			head: "feature",
			base: "main",
		});

		expect(result).toEqual({ ok: false, error: "Branch feature does not exist" });
		expect(prisma.repository.update).not.toHaveBeenCalled();
	});

	it("refuses a second pull request for the same pair of branches", async () => {
		vi.mocked(prisma.pullRequest.findFirst).mockResolvedValueOnce({
			id: "pr_1",
			number: 3,
		} as never);

		const result = await createHostedPull(hosted(["main", "feature"]), author, {
			title: "Add a thing",
			head: "feature",
			base: "main",
		});

		expect(result).toEqual({ ok: false, error: expect.stringContaining("#3") });
	});

	// Stacking is inferred rather than declared: basing on an open pull
	// request's head branch is what makes this one sit on top of it.
	it("stacks onto the open pull request whose head it is based on", async () => {
		vi.mocked(prisma.pullRequest.findFirst)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: "pr_parent", stackId: null } as never);

		const result = await createHostedPull(hosted(["main", "one", "two"]), author, {
			title: "Second",
			head: "two",
			base: "one",
		});

		expect(result).toMatchObject({
			ok: true,
			pullRequest: { parentId: "pr_parent", stackId: "pr_parent" },
		});
		// The parent joins the stack it now roots.
		expect(prisma.pullRequest.update).toHaveBeenCalledWith({
			where: { id: "pr_parent" },
			data: { stackId: "pr_parent" },
		});
	});

	it("rejects a pull request from a branch onto itself", async () => {
		const result = await createHostedPull(hosted(["main"]), author, {
			title: "Add a thing",
			head: "main",
			base: "main",
		});

		expect(result).toEqual({ ok: false, error: expect.stringContaining("same") });
	});
});
