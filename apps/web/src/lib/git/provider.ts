import type {
	BlameHunk,
	BranchRef,
	CommitDetail,
	CommitFilesInput,
	CommitPatchInput,
	CommitSummary,
	CompareResult,
	CreateRepoInit,
	FileBlob,
	FileDiff,
	GitScope,
	GrepMatch,
	GrepOptions,
	MergeOptions,
	MergePreview,
	MergeResult,
	MergeStrategy,
	Page,
	RepoGitInfo,
	RepoRef,
	TagRef,
	TreeEntry,
	TreeEntryWithCommit,
} from "./types";

/**
 * The only interface the app talks to for git data.
 *
 * It is the *intersection* of what the backends can do: nothing above this
 * layer may branch on which backend is active. A primitive a backend cannot
 * serve throws `UnsupportedGitOperation` rather than changing the signature.
 */
export interface GitProvider {
	/** Identifies the adapter, for logging and `Repository.gitBackend`. */
	readonly backend: string;

	/**
	 * The merge strategies this backend really performs. Callers offer only
	 * these, so a backend without a rebase primitive declines it instead of
	 * being handed one and answering with something else.
	 */
	readonly mergeStrategies: readonly MergeStrategy[];

	getRepo(r: RepoRef): Promise<RepoGitInfo | null>;
	listRepos(q?: string, cursor?: string): Promise<Page<RepoGitInfo>>;
	createRepo(r: RepoRef, init?: CreateRepoInit): Promise<RepoGitInfo>;
	deleteRepo(r: RepoRef): Promise<void>;

	listBranches(r: RepoRef, cursor?: string): Promise<Page<BranchRef>>;
	/** `from` is an existing ref name, not a sha. */
	createBranch(r: RepoRef, name: string, from: string): Promise<BranchRef>;
	deleteBranch(r: RepoRef, name: string): Promise<void>;
	listTags(r: RepoRef, cursor?: string): Promise<Page<TagRef>>;
	createTag(r: RepoRef, name: string, target: string): Promise<TagRef>;
	deleteTag(r: RepoRef, name: string): Promise<void>;

	listCommits(
		r: RepoRef,
		o?: { branch?: string; path?: string; cursor?: string; limit?: number },
	): Promise<Page<CommitSummary>>;
	getCommit(r: RepoRef, ref: string): Promise<CommitDetail | null>;
	getCommitDiff(
		r: RepoRef,
		ref: string,
		o?: { base?: string; paths?: string[] },
	): Promise<FileDiff[]>;
	compare(r: RepoRef, base: string, head: string, paths?: string[]): Promise<CompareResult>;

	listFiles(
		r: RepoRef,
		ref: string,
		o?: { path?: string; recursive?: boolean },
	): Promise<TreeEntry[]>;
	listFilesWithMetadata(
		r: RepoRef,
		ref: string,
		path?: string,
	): Promise<TreeEntryWithCommit[]>;
	getFileContent(r: RepoRef, path: string, ref?: string): Promise<FileBlob | null>;
	getBlame(
		r: RepoRef,
		path: string,
		ref?: string,
		range?: [number, number],
	): Promise<BlameHunk[]>;
	grep(r: RepoRef, pattern: string, o?: GrepOptions): Promise<Page<GrepMatch>>;

	previewMerge(r: RepoRef, base: string, head: string): Promise<MergePreview>;
	merge(r: RepoRef, base: string, head: string, o: MergeOptions): Promise<MergeResult>;
	commitFiles(r: RepoRef, i: CommitFilesInput): Promise<CommitSummary>;
	commitPatch(r: RepoRef, i: CommitPatchInput): Promise<CommitSummary>;

	getArchiveStream(r: RepoRef, ref: string): Promise<ReadableStream<Uint8Array>>;
	/**
	 * Short-lived authenticated clone/push URL. Callers must already have
	 * checked the viewer's permission — this mints credentials.
	 */
	getRemoteUrl(r: RepoRef, scopes: GitScope[], ttlSeconds: number): Promise<string>;
}
