import { type ConflictFileData, threeWayMerge } from "@/lib/three-way-merge";
import type { HostedRepo } from "@/lib/repos/hosted-source";

/**
 * The three-way merge a conflict resolution is built from, independent of where
 * the bytes come from.
 *
 * Both a repository we host and one still on GitHub answer the same three
 * questions — which paths differ, and what each of them looks like at the merge
 * base, the base tip and the head tip — so the classification below is shared
 * and only the reader changes.
 */

export interface ConflictSet {
	mergeBaseSha: string;
	baseBranch: string;
	headBranch: string;
	/** Tips the resolution was computed from, so a commit can guard on them. */
	baseSha: string;
	headSha: string;
	files: ConflictFileData[];
}

/** Reads a path at a revision, or null when it does not exist there. */
export type BlobReader = (path: string, ref: string) => Promise<string | null>;

const MAX_FILES = 30;

function clean(path: string, lines: string[]): ConflictFileData {
	return {
		path,
		hunks: [{ type: "clean", resolvedLines: lines }],
		hasConflicts: false,
		autoResolved: true,
	};
}

/**
 * A file only one side touched needs no decision, and neither does one both
 * sides left alone — only a file both sides changed goes through the merge.
 */
function classify(
	path: string,
	ancestorContent: string | null,
	baseContent: string | null,
	headContent: string | null,
): ConflictFileData {
	if (ancestorContent === null && baseContent === null && headContent !== null) {
		return clean(path, headContent.split("\n"));
	}
	if (ancestorContent === null && headContent === null && baseContent !== null) {
		return clean(path, baseContent.split("\n"));
	}
	if (baseContent === null && headContent === null) {
		return { path, hunks: [], hasConflicts: false, autoResolved: true };
	}

	const ancestor = (ancestorContent ?? "").split("\n");
	const baseLines = (baseContent ?? "").split("\n");
	const headLines = (headContent ?? "").split("\n");
	const baseChanged = baseContent !== ancestorContent;
	const headChanged = headContent !== ancestorContent;

	if (baseChanged && !headChanged) return clean(path, baseLines);
	if (headChanged && !baseChanged) return clean(path, headLines);
	if (!baseChanged && !headChanged) return clean(path, ancestor);

	const result = threeWayMerge(ancestor, baseLines, headLines);
	return {
		path,
		hunks: result.hunks,
		hasConflicts: result.hasConflicts,
		autoResolved: !result.hasConflicts,
	};
}

export async function conflictFiles(
	paths: string[],
	read: BlobReader,
	refs: { mergeBase: string; base: string; head: string },
): Promise<ConflictFileData[]> {
	return Promise.all(
		paths.slice(0, MAX_FILES).map(async (path) => {
			const [ancestor, base, head] = await Promise.all([
				read(path, refs.mergeBase),
				read(path, refs.base),
				read(path, refs.head),
			]);
			return classify(path, ancestor, base, head);
		}),
	);
}

/**
 * Conflicts for a pull request we own, entirely from the git backend, so the
 * resolver keeps working while GitHub is down.
 */
export async function hostedConflicts(
	h: HostedRepo,
	baseBranch: string,
	headBranch: string,
): Promise<ConflictSet> {
	const preview = await h.git.previewMerge(h.ref, baseBranch, headBranch);
	const mergeBase = preview.mergeBaseSha ?? baseBranch;
	const diff = await h.git.compare(h.ref, baseBranch, headBranch);

	const read: BlobReader = async (path, ref) => {
		const blob = await h.git.getFileContent(h.ref, path, ref).catch(() => null);
		// A binary file has no lines to merge, so it is reported as absent and
		// left for the author rather than corrupted by a text merge.
		if (!blob || blob.binary) return null;
		return new TextDecoder().decode(blob.content);
	};

	return {
		mergeBaseSha: mergeBase,
		baseBranch,
		headBranch,
		baseSha: preview.baseSha,
		headSha: preview.headSha,
		files: await conflictFiles(
			diff.files.map((f) => f.path),
			read,
			{ mergeBase, base: preview.baseSha, head: preview.headSha },
		),
	};
}
