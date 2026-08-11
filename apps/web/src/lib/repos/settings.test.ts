import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Repository } from "@/generated/prisma/client";
import type { GitProvider } from "@/lib/git/provider";
import type { BranchRef, Page } from "@/lib/git/types";

vi.mock("@/lib/db", () => ({
	prisma: {
		repository: {
			update: vi.fn(),
			delete: vi.fn(),
		},
	},
}));
vi.mock("./registry", () => ({
	findRepository: vi.fn().mockResolvedValue(null),
	repositoryPermission: vi.fn(),
}));

import { prisma } from "@/lib/db";
import type { HostedRepo } from "./hosted-source";
import { findRepository, repositoryPermission } from "./registry";
import { deleteHostedRepository, updateHostedRepository } from "./settings";

function record(overrides: Partial<Repository> = {}): Repository {
	return {
		id: "repo_1",
		owner: "adam",
		name: "hello",
		defaultBranch: "main",
		gitBackend: "code-storage",
		gitRepoId: "HMZ2NNp13deleRLM4qIWG",
		gitOwner: "adam",
		gitName: "hello",
		archived: false,
		...overrides,
	} as Repository;
}

function branches(...names: string[]): Page<BranchRef> {
	return {
		items: names.map((name) => ({ name, sha: "a".repeat(40), createdAt: null })),
		nextCursor: null,
		hasMore: false,
	};
}

function repo(row: Repository = record(), git: Partial<GitProvider> = {}): HostedRepo {
	return {
		ref: { owner: "adam", repo: "hello" },
		git: {
			listBranches: vi.fn().mockResolvedValue(branches("main", "dev")),
			deleteRepo: vi.fn().mockResolvedValue(undefined),
			...git,
		} as unknown as GitProvider,
		defaultBranch: row.defaultBranch,
		record: row,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(repositoryPermission).mockResolvedValue("admin");
	vi.mocked(findRepository).mockResolvedValue(null);
	vi.mocked(prisma.repository.update).mockImplementation((async (args: any) =>
		record(args.data)) as never);
});

describe("updateHostedRepository", () => {
	it("writes the settings we own without touching the backend", async () => {
		const h = repo();
		const result = await updateHostedRepository(h, "user_1", {
			description: "ours now",
			topics: ["git"],
		});

		expect(result.ok).toBe(true);
		expect(prisma.repository.update).toHaveBeenCalledWith({
			where: { id: "repo_1" },
			data: { description: "ours now", topics: ["git"] },
		});
	});

	it("refuses anyone who is not an admin", async () => {
		vi.mocked(repositoryPermission).mockResolvedValue("write");
		const result = await updateHostedRepository(repo(), "user_2", { isPrivate: true });

		expect(result).toEqual({
			ok: false,
			error: "You need admin access to change these settings",
		});
		expect(prisma.repository.update).not.toHaveBeenCalled();
	});

	it("refuses a default branch the backend does not have", async () => {
		const result = await updateHostedRepository(repo(), "user_1", {
			defaultBranch: "gone",
		});

		expect(result).toEqual({ ok: false, error: "Branch gone no longer exists" });
		expect(prisma.repository.update).not.toHaveBeenCalled();
	});

	it("accepts a default branch the backend has", async () => {
		const result = await updateHostedRepository(repo(), "user_1", {
			defaultBranch: "dev",
		});

		expect(result.ok).toBe(true);
	});

	it("renames what we display and nothing the backend is addressed by", async () => {
		const result = await updateHostedRepository(repo(), "user_1", { name: "hello-2" });

		expect(result.ok).toBe(true);
		expect(prisma.repository.update).toHaveBeenCalledWith({
			where: { id: "repo_1" },
			data: { name: "hello-2" },
		});
	});

	it("refuses a rename onto a name that is taken", async () => {
		vi.mocked(findRepository).mockResolvedValue(
			record({ id: "repo_2", name: "taken" }),
		);
		const result = await updateHostedRepository(repo(), "user_1", { name: "taken" });

		expect(result).toEqual({ ok: false, error: "adam/taken already exists" });
	});

	it("refuses a name git could not carry", async () => {
		const result = await updateHostedRepository(repo(), "user_1", { name: "not ok/" });

		expect(result.ok).toBe(false);
	});

	it("only accepts the edit that lifts an archive", async () => {
		const archived = repo(record({ archived: true }));

		expect(
			await updateHostedRepository(archived, "user_1", { description: "x" }),
		).toEqual({
			ok: false,
			error: "This repository is archived",
		});
		expect(
			(await updateHostedRepository(archived, "user_1", { archived: false })).ok,
		).toBe(true);
	});
});

describe("deleteHostedRepository", () => {
	it("drops the row before the git data", async () => {
		const h = repo();
		expect(await deleteHostedRepository(h, "user_1")).toEqual({ ok: true });
		expect(prisma.repository.delete).toHaveBeenCalledWith({ where: { id: "repo_1" } });
		expect(h.git.deleteRepo).toHaveBeenCalledWith(h.ref);
	});

	it("still removes the repository when the backend cannot", async () => {
		const h = repo(record(), {
			deleteRepo: vi.fn().mockRejectedValue(new Error("503")),
		});

		expect(await deleteHostedRepository(h, "user_1")).toEqual({ ok: true });
		expect(prisma.repository.delete).toHaveBeenCalled();
	});

	it("refuses anyone who is not an admin", async () => {
		vi.mocked(repositoryPermission).mockResolvedValue("write");
		const h = repo();

		expect((await deleteHostedRepository(h, "user_2")).ok).toBe(false);
		expect(prisma.repository.delete).not.toHaveBeenCalled();
		expect(h.git.deleteRepo).not.toHaveBeenCalled();
	});
});
