import { describe, expect, it, vi } from "vitest";
import type { Repository } from "@/generated/prisma/client";

vi.mock("@/lib/db", () => ({
	prisma: { repository: { updateMany: vi.fn(() => Promise.resolve({ count: 1 })) } },
}));

import { prisma } from "@/lib/db";
import { mirrorStatus, mirrorUpstreamAuth, recordMirrorPush, recordMirrorSync } from "./mirror";

function record(overrides: Partial<Repository> = {}): Repository {
	return {
		upstreamHost: "github.com",
		upstreamOwner: "adam",
		upstreamName: "hello",
		mirrorMode: "off",
		mirrorState: null,
		mirrorError: null,
		mirrorSyncedAt: null,
		...overrides,
	} as Repository;
}

describe("mirrorUpstreamAuth", () => {
	it("needs the app installation to forward writes, whatever the visibility", () => {
		expect(mirrorUpstreamAuth("refs", false)).toBe("installation");
		expect(mirrorUpstreamAuth("refs", true)).toBe("installation");
	});

	it("imports without mirroring as before: anonymous, or the user's token", () => {
		expect(mirrorUpstreamAuth("off", false)).toBe("public");
		expect(mirrorUpstreamAuth("off", true)).toBe("token");
	});
});

describe("mirrorStatus", () => {
	it("reports the upstream it mirrors to and the last run", () => {
		const syncedAt = new Date("2026-08-16T10:00:00Z");
		expect(
			mirrorStatus(
				record({
					mirrorMode: "refs",
					mirrorState: "synced",
					mirrorSyncedAt: syncedAt,
				}),
			),
		).toEqual({
			mode: "refs",
			state: "synced",
			error: null,
			syncedAt,
			upstream: {
				owner: "adam",
				repo: "hello",
				url: "https://github.com/adam/hello",
			},
		});
	});

	it("has no upstream once nothing is upstream, and no state it cannot name", () => {
		const status = mirrorStatus(
			record({ upstreamHost: null, mirrorState: "something-new" }),
		);
		expect(status.upstream).toBeNull();
		expect(status.state).toBeNull();
		expect(status.mode).toBe("off");
	});
});

describe("recordMirrorSync", () => {
	const at = new Date("2026-08-16T10:00:00Z");

	it("dates a success and clears the previous failure", async () => {
		await recordMirrorSync({ gitRepoId: "repo_1", state: "synced", at });
		expect(prisma.repository.updateMany).toHaveBeenCalledWith({
			where: { gitRepoId: "repo_1" },
			data: { mirrorState: "synced", mirrorError: null, mirrorSyncedAt: at },
		});
	});

	it("keeps the failure reason, and does not date a run that failed", async () => {
		await recordMirrorSync({
			gitRepoId: "repo_1",
			state: "failed",
			error: "failed to push to storage",
			at,
		});
		expect(prisma.repository.updateMany).toHaveBeenLastCalledWith({
			where: { gitRepoId: "repo_1" },
			data: { mirrorState: "failed", mirrorError: "failed to push to storage" },
		});
	});

	it("names the failure even when the backend did not", async () => {
		await recordMirrorSync({ gitRepoId: "repo_1", state: "failed", at });
		expect(prisma.repository.updateMany).toHaveBeenLastCalledWith({
			where: { gitRepoId: "repo_1" },
			data: { mirrorState: "failed", mirrorError: "sync failed" },
		});
	});
});

describe("recordMirrorPush", () => {
	it("dates the repository the backend id belongs to", async () => {
		const at = new Date("2026-08-16T11:00:00Z");
		await recordMirrorPush("repo_1", at);
		expect(prisma.repository.updateMany).toHaveBeenLastCalledWith({
			where: { gitRepoId: "repo_1" },
			data: { updatedAt: at },
		});
	});
});
