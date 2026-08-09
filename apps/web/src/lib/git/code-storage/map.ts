import type {
	BlameHunk,
	BranchRef,
	CommitDetail,
	CommitSummary,
	DiffStats,
	FileChangeStatus,
	FileDiff,
	GrepMatch,
	MergeConflict,
	MergeStatus,
	Page,
	RepoGitInfo,
	TagRef,
	TreeEntry,
	TreeEntryWithCommit,
	UpstreamRef,
} from "../types";

/** Wire shapes returned by Code Storage, kept snake_case and isolated here. */

export interface WireRepo {
	repo_id: string;
	url: string;
	default_branch: string;
	created_at: string;
	base_repo?: { provider: string; owner: string; name: string } | null;
}

export interface WirePage {
	has_more: boolean;
	next_cursor?: string | null;
}

export interface WireBranch {
	name: string;
	head_sha: string;
	created_at?: string | null;
}

export interface WireTag {
	name: string;
	sha: string;
}

export interface WireCommit {
	sha: string;
	parent_shas?: string[] | null;
	message: string;
	author_name: string;
	author_email: string;
	committer_name: string;
	committer_email: string;
	date: string;
}

export interface WireStats {
	files: number;
	additions: number;
	deletions: number;
	changes?: number;
}

export interface WireDiffFile {
	path: string;
	state: string;
	raw?: string | null;
	bytes?: number | null;
	is_eof?: boolean | null;
}

export interface WireDiff {
	files?: WireDiffFile[] | null;
	filtered_files?: WireDiffFile[] | null;
	merge_base_sha?: string | null;
	sha?: string | null;
	base?: string | null;
	branch?: string | null;
	stats?: WireStats | null;
}

export interface WireTreeEntry {
	path: string;
	type: string;
	mode: string;
	size?: number | null;
	last_commit_sha?: string | null;
}

export interface WireBlameLine {
	commit_sha: string;
	line_number: number;
	author_name: string;
	author_email: string;
	author_time: string;
	summary: string;
}

export interface WireGrepMatch {
	path: string;
	lines: { line_number: number; text: string; type: string }[];
}

export interface WireConflictBlob {
	content?: string | null;
	binary: boolean;
	truncated: boolean;
}

export interface WireMergePreview {
	status: "clean" | "conflicted";
	result: string;
	source_tip_sha: string;
	target_tip_sha: string;
	merge_base_sha?: string | null;
	conflict_paths: string[];
	conflicts?: { path: string; ours?: WireConflictBlob | null }[] | null;
}

export interface WireMergeResult {
	commit_sha?: string | null;
	merge_base_sha?: string | null;
	result: string;
	target?: { new_sha?: string | null } | null;
}

const EMPTY_STATS: DiffStats = { files: 0, additions: 0, deletions: 0 };

export function toPage<W, T>(
	wire: WirePage | null,
	items: W[] | null | undefined,
	map: (item: W) => T,
): Page<T> {
	return {
		items: (items ?? []).map(map),
		nextCursor: wire?.next_cursor ?? null,
		hasMore: wire?.has_more ?? false,
	};
}

function toUpstream(base: WireRepo["base_repo"]): UpstreamRef | null {
	if (!base) return null;
	const provider = base.provider;
	return {
		provider:
			provider === "github" || provider === "gitlab" || provider === "bitbucket"
				? provider
				: "generic",
		owner: base.owner,
		name: base.name,
	};
}

export function toRepo(wire: WireRepo): RepoGitInfo {
	const [owner = "", ...rest] = wire.url.split("/");
	return {
		id: wire.repo_id,
		owner,
		name: rest.join("/"),
		defaultBranch: wire.default_branch,
		createdAt: wire.created_at,
		upstream: toUpstream(wire.base_repo),
	};
}

export function toBranch(wire: WireBranch): BranchRef {
	return { name: wire.name, sha: wire.head_sha, createdAt: wire.created_at ?? null };
}

export function toTag(wire: WireTag): TagRef {
	return { name: wire.name, sha: wire.sha };
}

export function toCommit(wire: WireCommit): CommitSummary {
	return {
		sha: wire.sha,
		message: wire.message,
		parents: wire.parent_shas ?? [],
		author: { name: wire.author_name, email: wire.author_email },
		committer: { name: wire.committer_name, email: wire.committer_email },
		date: wire.date,
	};
}

export function toCommitDetail(wire: WireCommit, stats: DiffStats | null): CommitDetail {
	return { ...toCommit(wire), stats };
}

/** Git status letters can carry a similarity score, e.g. `R096`. */
export function toFileStatus(state: string): FileChangeStatus {
	const letter = state.trim().charAt(0).toUpperCase();
	return letter === "A" ||
		letter === "D" ||
		letter === "R" ||
		letter === "C" ||
		letter === "T"
		? letter
		: "M";
}

function toFileDiff(wire: WireDiffFile, filtered: boolean): FileDiff {
	return {
		path: wire.path,
		status: toFileStatus(wire.state),
		patch: wire.raw ?? null,
		truncated: filtered || wire.is_eof === false,
		bytes: wire.bytes ?? null,
	};
}

export function toFileDiffs(wire: WireDiff | null): FileDiff[] {
	return [
		...(wire?.files ?? []).map((file) => toFileDiff(file, false)),
		...(wire?.filtered_files ?? []).map((file) => toFileDiff(file, true)),
	];
}

export function toStats(wire: WireStats | null | undefined): DiffStats {
	if (!wire) return EMPTY_STATS;
	return { files: wire.files, additions: wire.additions, deletions: wire.deletions };
}

function toEntryType(type: string): TreeEntry["type"] {
	return type === "tree" || type === "commit" ? type : "blob";
}

export function toTreeEntry(wire: WireTreeEntry): TreeEntry {
	return {
		path: wire.path,
		type: toEntryType(wire.type),
		mode: wire.mode,
		size: wire.size ?? null,
	};
}

export function toTreeEntryWithCommit(wire: WireTreeEntry): TreeEntryWithCommit {
	return { ...toTreeEntry(wire), lastCommitSha: wire.last_commit_sha ?? null };
}

/** Code Storage returns per-line blame; the UI renders contiguous hunks. */
export function toBlameHunks(path: string, lines: WireBlameLine[]): BlameHunk[] {
	const hunks: BlameHunk[] = [];
	for (const line of lines) {
		const previous = hunks.at(-1);
		if (
			previous &&
			previous.sha === line.commit_sha &&
			previous.endLine === line.line_number - 1
		) {
			previous.endLine = line.line_number;
			continue;
		}
		hunks.push({
			path,
			sha: line.commit_sha,
			startLine: line.line_number,
			endLine: line.line_number,
			author: { name: line.author_name, email: line.author_email },
			date: line.author_time,
			summary: line.summary,
		});
	}
	return hunks;
}

/** Grep groups lines per file; the canonical shape is one entry per match line. */
export function toGrepMatches(wire: WireGrepMatch[]): GrepMatch[] {
	return wire.flatMap<GrepMatch>((file) => {
		const matches = file.lines.filter((line) => line.type === "match");
		if (matches.length === 0)
			return [{ path: file.path, lineNumber: null, line: null }];
		return matches.map((line) => ({
			path: file.path,
			lineNumber: line.line_number,
			line: line.text,
		}));
	});
}

export function toMergeConflicts(wire: WireMergePreview): MergeConflict[] {
	const contentByPath = new Map(
		(wire.conflicts ?? []).map((conflict) => [
			conflict.path,
			conflict.ours?.content ?? null,
		]),
	);
	return wire.conflict_paths.map((path) => ({
		path,
		content: contentByPath.get(path) ?? null,
	}));
}

export function toMergeStatus(wire: WireMergePreview): MergeStatus {
	if (wire.status === "conflicted") return "conflicted";
	return wire.result === "no_op" ? "up_to_date" : "clean";
}
