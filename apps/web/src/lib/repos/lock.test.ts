import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { $executeRaw: vi.fn() } }));

import { prisma } from "@/lib/db";
import { RepoBusyError, withRepoLock } from "./lock";

const executeRaw = vi.mocked(prisma.$executeRaw);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("withRepoLock", () => {
	it("runs the work outside any transaction and gives the lease back", async () => {
		executeRaw.mockResolvedValue(1);
		let heldDuringWork = false;

		const result = await withRepoLock("repo_1", async () => {
			// One statement so far: taking the lease. Nothing is holding a
			// transaction open around this call.
			heldDuringWork = executeRaw.mock.calls.length === 1;
			return "merged";
		});

		expect(result).toBe("merged");
		expect(heldDuringWork).toBe(true);
		// Taken, then released.
		expect(executeRaw).toHaveBeenCalledTimes(2);
	});

	it("releases the lease when the work throws", async () => {
		executeRaw.mockResolvedValue(1);

		await expect(
			withRepoLock("repo_1", async () => {
				throw new Error("backend exploded");
			}),
		).rejects.toThrow("backend exploded");
		expect(executeRaw).toHaveBeenCalledTimes(2);
	});

	it("refuses rather than queueing forever when another holder keeps it", async () => {
		vi.useFakeTimers();
		// Nobody ever wins the lease.
		executeRaw.mockResolvedValue(0);
		const run = vi.fn();

		const pending = withRepoLock("repo_1", run).catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(31_000);

		expect(await pending).toBeInstanceOf(RepoBusyError);
		expect(run).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});
