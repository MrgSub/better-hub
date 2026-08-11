/**
 * Canonical git types shared by every backend adapter.
 *
 * Shapes stay close to the GitHub REST payloads the UI already renders so the
 * call sites migrating off `lib/github.ts` do not have to change their markup.
 */

export interface RepoRef {
	owner: string;
	repo: string;
}

export type GitScope = "read" | "write" | "admin";

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
	hasMore: boolean;
}

export interface UpstreamRef {
	provider: "github" | "gitlab" | "bitbucket" | "generic";
	owner: string;
	name: string;
	url?: string;
	/** Upstream branch to track; defaults to the new repo's default branch. */
	defaultBranch?: string;
	/**
	 * How the backend reads the upstream: anonymously, with a credential the
	 * caller supplies, or through the GitHub App installation. Defaults to
	 * public; private repositories need `token` or `installation`.
	 */
	auth?: "public" | "token" | "installation";
}

/** HTTPS credential the backend uses to read a private upstream. */
export interface UpstreamCredential {
	username?: string;
	password: string;
}

/** Another repository on the same backend, copied at a point in time. */
export interface ForkSource {
	repo: RepoRef;
	/** Branch or tag to fork from; defaults to the source's default branch. */
	ref?: string;
}

export interface CreateRepoInit {
	defaultBranch?: string;
	baseRepo?: UpstreamRef;
	/** Required when `baseRepo.auth` is `token`. */
	credential?: UpstreamCredential;
	/** Mutually exclusive with `baseRepo`: copy a repo we already host. */
	forkOf?: ForkSource;
}

export interface RepoGitInfo {
	/** Backend-assigned id, stored on `Repository.gitRepoId`. */
	id: string;
	owner: string;
	name: string;
	defaultBranch: string;
	createdAt: string;
	upstream: UpstreamRef | null;
}

export interface BranchRef {
	name: string;
	sha: string;
	createdAt: string | null;
}

export interface TagRef {
	name: string;
	sha: string;
}

export interface GitActor {
	name: string;
	email: string;
}

export interface CommitSummary {
	sha: string;
	message: string;
	parents: string[];
	author: GitActor;
	committer: GitActor;
	date: string;
}

export interface DiffStats {
	files: number;
	additions: number;
	deletions: number;
}

export interface CommitDetail extends CommitSummary {
	stats: DiffStats | null;
}

/** Matches git's status letters: added, modified, deleted, renamed, copied, type-changed. */
export type FileChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface FileDiff {
	path: string;
	status: FileChangeStatus;
	/** Unified diff. Null when the backend omitted it (binary or size-filtered). */
	patch: string | null;
	/** True when the backend truncated or skipped the patch body. */
	truncated: boolean;
	bytes: number | null;
}

export interface CompareResult {
	baseSha: string;
	headSha: string;
	mergeBaseSha: string | null;
	files: FileDiff[];
	stats: DiffStats;
}

export interface TreeEntry {
	path: string;
	type: "blob" | "tree" | "commit";
	mode: string;
	size: number | null;
}

export interface TreeEntryWithCommit extends TreeEntry {
	lastCommitSha: string | null;
}

export interface FileBlob {
	path: string;
	ref: string;
	content: Uint8Array;
	size: number;
	/** Heuristic: set when the blob contains NUL bytes. */
	binary: boolean;
}

export interface BlameHunk {
	path: string;
	sha: string;
	startLine: number;
	endLine: number;
	author: GitActor;
	date: string;
	summary: string;
}

export interface GrepOptions {
	ref?: string;
	caseSensitive?: boolean;
	limit?: number;
	cursor?: string;
	contextBefore?: number;
	contextAfter?: number;
}

export interface GrepMatch {
	path: string;
	lineNumber: number | null;
	line: string | null;
}

export type MergeStatus = "clean" | "conflicted" | "up_to_date";

export interface MergeConflict {
	path: string;
	/** Present only when the backend was asked for, and could return, contents. */
	content: string | null;
}

export interface MergePreview {
	status: MergeStatus;
	mergeBaseSha: string | null;
	baseSha: string;
	headSha: string;
	conflicts: MergeConflict[];
}

/**
 * How a merge is performed. `fast_forward` and `rebase` both produce a linear
 * history, but they are not the same promise: a fast-forward only moves the
 * base pointer to a head that already carries it, while a rebase rewrites the
 * head's commits onto the base. A backend that can only do the former must say
 * so rather than quietly substituting it — see `GitProvider.mergeStrategies`.
 */
export type MergeStrategy = "merge" | "squash" | "fast_forward" | "rebase";

export interface MergeOptions {
	/** Required: a merge commit needs an author even when the caller has no message. */
	author: GitActor;
	message?: string;
	strategy?: MergeStrategy;
	/** Optimistic-concurrency guard: refuse the merge if base moved. */
	expectedBaseSha?: string;
}

export interface MergeResult {
	merged: boolean;
	sha: string | null;
	status: MergeStatus;
	conflicts: MergeConflict[];
}

export interface CommitFileChange {
	path: string;
	/** Omit for a deletion. */
	content?: Uint8Array | string;
	mode?: string;
	deleted?: boolean;
}

export interface CommitFilesInput {
	branch: string;
	message: string;
	author: GitActor;
	files: CommitFileChange[];
	expectedHeadSha?: string;
}

export interface CommitPatchInput {
	branch: string;
	message: string;
	author: GitActor;
	patch: string;
	expectedHeadSha?: string;
}

/** What a read needs from the backing repo, so adapters can fetch the minimum. */
export interface RefNeed {
	refs: string[];
	depth?: number;
}

export type GitErrorCode =
	| "not_found"
	| "unauthorized"
	| "forbidden"
	| "conflict"
	| "rate_limited"
	| "unsupported"
	| "backend_error";

export class GitError extends Error {
	readonly code: GitErrorCode;
	readonly status: number | null;

	constructor(code: GitErrorCode, message: string, status: number | null = null) {
		super(message);
		this.name = "GitError";
		this.code = code;
		this.status = status;
	}
}

/**
 * Thrown when the configured backend cannot serve a primitive at all, so call
 * sites degrade instead of branching on which backend is active.
 */
export class UnsupportedGitOperation extends GitError {
	constructor(operation: string, backend: string) {
		super("unsupported", `${operation} is not supported by the ${backend} git backend`);
		this.name = "UnsupportedGitOperation";
	}
}
