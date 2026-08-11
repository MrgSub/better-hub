import { describe, expect, it } from "vitest";
import { conflictFiles } from "./conflicts";

const refs = { mergeBase: "sha_base", base: "sha_main", head: "sha_head" };

/** Serves file contents per revision, with `null` for "not there". */
function reader(files: Record<string, Record<string, string | null>>) {
	return async (path: string, ref: string) => files[path]?.[ref] ?? null;
}

describe("conflictFiles", () => {
	it("conflicts on a file both branches created differently", async () => {
		const [file] = await conflictFiles(
			["config.txt"],
			reader({
				"config.txt": {
					sha_base: null,
					sha_main: "value = base\n",
					sha_head: "value = head\n",
				},
			}),
			refs,
		);

		expect(file.hasConflicts).toBe(true);
		expect(file.autoResolved).toBe(false);
		expect(file.hunks).toEqual([
			{
				type: "conflict",
				ancestorLines: [],
				baseLines: ["value = base", ""],
				headLines: ["value = head", ""],
			},
		]);
	});

	it("accepts a file both branches created identically", async () => {
		const [file] = await conflictFiles(
			["same.txt"],
			reader({
				"same.txt": {
					sha_base: null,
					sha_main: "same\n",
					sha_head: "same\n",
				},
			}),
			refs,
		);

		expect(file.hasConflicts).toBe(false);
		expect(file.hunks).toEqual([{ type: "clean", resolvedLines: ["same", ""] }]);
	});

	it("conflicts when both branches insert at the same line of a shared file", async () => {
		const [file] = await conflictFiles(
			["shared.txt"],
			reader({
				"shared.txt": {
					sha_base: "one\ntwo\n",
					sha_main: "one\nfrom base\ntwo\n",
					sha_head: "one\nfrom head\ntwo\n",
				},
			}),
			refs,
		);

		expect(file.hasConflicts).toBe(true);
		expect(file.hunks).toEqual([
			{ type: "clean", resolvedLines: ["one"] },
			{
				type: "conflict",
				ancestorLines: [],
				baseLines: ["from base"],
				headLines: ["from head"],
			},
			{ type: "clean", resolvedLines: ["two", ""] },
		]);
	});

	it("merges edits the branches made in different places", async () => {
		const [file] = await conflictFiles(
			["apart.txt"],
			reader({
				"apart.txt": {
					sha_base: "one\ntwo\nthree\n",
					sha_main: "one changed\ntwo\nthree\n",
					sha_head: "one\ntwo\nthree changed\n",
				},
			}),
			refs,
		);

		expect(file.hasConflicts).toBe(false);
		expect(file.hunks).toEqual([
			{
				type: "clean",
				resolvedLines: ["one changed", "two", "three changed", ""],
			},
		]);
	});

	it("needs no decision for a file only one branch touched", async () => {
		const [onlyHead, onlyBase] = await conflictFiles(
			["head.txt", "base.txt"],
			reader({
				"head.txt": { sha_base: null, sha_main: null, sha_head: "new\n" },
				"base.txt": {
					sha_base: "old\n",
					sha_main: "changed\n",
					sha_head: "old\n",
				},
			}),
			refs,
		);

		expect(onlyHead).toMatchObject({ hasConflicts: false, autoResolved: true });
		expect(onlyBase.hunks).toEqual([{ type: "clean", resolvedLines: ["changed", ""] }]);
	});

	it("conflicts when one branch deletes what the other edited", async () => {
		const [file] = await conflictFiles(
			["gone.txt"],
			reader({
				"gone.txt": {
					sha_base: "one\n",
					sha_main: null,
					sha_head: "one changed\n",
				},
			}),
			refs,
		);

		expect(file.hasConflicts).toBe(true);
	});
});
