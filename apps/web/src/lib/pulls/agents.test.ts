import { describe, expect, it, vi } from "vitest";
import type { ConflictFileData } from "@/lib/three-way-merge";
import { MAX_CONFLICT_FILES, retrying, tooLargeToResolve } from "./agents";
import type { ConflictAgent } from "./resolve";

function file(path: string, lines: string[]): ConflictFileData {
	return {
		path,
		hasConflicts: true,
		hunks: [{ type: "conflict", baseLines: lines, headLines: lines }],
	} as unknown as ConflictFileData;
}

const request = {
	title: "t",
	body: "",
	baseBranch: "main",
	headBranch: "feature",
	files: [file("a.ts", ["x"])],
	userId: "user_1",
};

describe("tooLargeToResolve", () => {
	it("allows a conflict an agent can plausibly hold in its head", () => {
		expect(tooLargeToResolve([file("a.ts", ["one", "two"])])).toBeNull();
	});

	it("refuses too many files before an agent is paid for them", () => {
		const files = Array.from({ length: MAX_CONFLICT_FILES + 1 }, (_, i) =>
			file(`f${i}.ts`, ["x"]),
		);
		expect(tooLargeToResolve(files)).toMatch(/too many/);
	});

	it("refuses a conflict past the byte ceiling", () => {
		const wide = file(
			"b.ts",
			Array.from({ length: 200 }, () => "y".repeat(4096)),
		);
		expect(tooLargeToResolve([wide])).toMatch(/automatic limit/);
	});
});

describe("retrying", () => {
	it("asks again when the failure was the connection", async () => {
		const resolve = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValue([{ path: "a.ts", content: "ok" }]);
		const agent: ConflictAgent = { name: "test", resolve };

		expect(await retrying(agent, 2).resolve(request)).toEqual([
			{ path: "a.ts", content: "ok" },
		]);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("does not spend a second call on a request the agent rejected", async () => {
		const resolve = vi.fn().mockRejectedValue(new Error("invalid_request: bad prompt"));
		const agent: ConflictAgent = { name: "test", resolve };

		await expect(retrying(agent, 3).resolve(request)).rejects.toThrow(
			"invalid_request",
		);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("gives up after the last attempt rather than looping", async () => {
		const resolve = vi.fn().mockRejectedValue(new Error("503 unavailable"));
		const agent: ConflictAgent = { name: "test", resolve };

		await expect(retrying(agent, 2).resolve(request)).rejects.toThrow("503");
		expect(resolve).toHaveBeenCalledTimes(2);
	});
});
