import type { GitProvider } from "../provider";
import {
	type BlameHunk,
	type BranchRef,
	type CommitDetail,
	type CommitFilesInput,
	type CommitPatchInput,
	type CommitSummary,
	type CompareResult,
	type CreateRepoInit,
	type FileBlob,
	type FileDiff,
	GitError,
	type GitScope,
	type GrepMatch,
	type GrepOptions,
	type MergeOptions,
	type MergePreview,
	type MergeResult,
	type Page,
	type RepoGitInfo,
	type RepoRef,
	type TagRef,
	type TreeEntry,
	type TreeEntryWithCommit,
	type UpstreamRef,
} from "../types";
import { CodeStorageClient, repoId, toCodeStorageScopes } from "./client";
import {
	toBaseRepo,
	toBlameHunks,
	toForkBaseRepo,
	toBranch,
	toCommit,
	toCommitDetail,
	toFileDiffs,
	toGrepMatches,
	toMergeConflicts,
	toMergeStatus,
	toPage,
	toRepo,
	toStats,
	toTag,
	toTreeEntry,
	toTreeEntryWithCommit,
	type WireBlameLine,
	type WireBranch,
	type WireCommit,
	type WireDiff,
	type WireGrepMatch,
	type WireMergePreview,
	type WireMergeResult,
	type WirePage,
	type WireRepo,
	type WireTag,
	type WireTreeEntry,
} from "./map";

const NUL_BYTE = 0;

function encodeBase64(data: Uint8Array): string {
	return Buffer.from(data).toString("base64");
}

function toBytes(content: Uint8Array | string): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/**
 * Code Storage adapter.
 *
 * Nearly every method is a single REST call plus `map.ts`, because the backend
 * ships the diff/merge/blame/grep primitives natively.
 */
export class CodeStorageProvider implements GitProvider {
	readonly backend = "code-storage";
	private readonly client: CodeStorageClient;

	constructor(client: CodeStorageClient = new CodeStorageClient()) {
		this.client = client;
	}

	async getRepo(r: RepoRef): Promise<RepoGitInfo | null> {
		const wire = await this.client.json<WireRepo>("/repo", {
			repo: r,
			scopes: ["git:read"],
			allowNotFound: true,
		});
		return wire ? toRepo(wire) : null;
	}

	async listRepos(q?: string, cursor?: string): Promise<Page<RepoGitInfo>> {
		const wire = await this.client.json<WirePage & { repos: WireRepo[] }>("/repos", {
			scopes: ["org:read"],
			query: { q, cursor },
		});
		return toPage(wire, wire?.repos, toRepo);
	}

	async createRepo(r: RepoRef, init?: CreateRepoInit): Promise<RepoGitInfo> {
		const defaultBranch = init?.defaultBranch ?? "main";
		const baseRepo = init?.forkOf
			? toForkBaseRepo(
					init.forkOf,
					await this.client.signToken(["git:read"], init.forkOf.repo),
					defaultBranch,
				)
			: init?.baseRepo
				? toBaseRepo(init.baseRepo, defaultBranch)
				: null;
		const created = await this.client.json<{ repo_id: string }>("/repos", {
			repo: r,
			scopes: ["repo:write"],
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({
				default_branch: defaultBranch,
				...(baseRepo ? { base_repo: baseRepo } : {}),
			}),
		});

		// A credentialed upstream is configured but not cloned by create: the
		// credential can only be stored once the repo exists, so the first
		// fetch has to be triggered afterwards.
		if (init?.baseRepo && init.credential) {
			await this.client.json("/repos/git-credentials", {
				repo: r,
				scopes: ["repo:write"],
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({
					repo_id: created?.repo_id,
					username: init.credential.username ?? "x-access-token",
					password: init.credential.password,
				}),
			});
			await this.pullUpstream(r);
		}

		const info = await this.getRepo(r);
		if (info) return info;
		// The repo exists (create returned 201) but the read raced its indexing.
		return {
			id: created?.repo_id ?? repoId(r),
			owner: r.owner,
			name: r.repo,
			defaultBranch,
			createdAt: new Date().toISOString(),
			upstream: init?.baseRepo ?? null,
		};
	}

	/** Re-fetches a sync-backed repository from its upstream. */
	async pullUpstream(r: RepoRef): Promise<void> {
		await this.client.json("/repos/pull-upstream", {
			repo: r,
			scopes: ["git:write"],
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({}),
		});
	}

	async deleteRepo(r: RepoRef): Promise<void> {
		await this.client.send204("/repos/delete", {
			repo: r,
			scopes: ["repo:write"],
			method: "DELETE",
		});
	}

	async listBranches(r: RepoRef, cursor?: string): Promise<Page<BranchRef>> {
		const wire = await this.client.json<WirePage & { branches: WireBranch[] }>(
			"/repos/branches",
			{
				repo: r,
				scopes: ["git:read"],
				query: { cursor },
			},
		);
		return toPage(wire, wire?.branches, toBranch);
	}

	async createBranch(r: RepoRef, name: string, from: string): Promise<BranchRef> {
		const wire = await this.client.json<{ commit_sha: string }>(
			"/repos/branches/create",
			{
				repo: r,
				scopes: ["git:write"],
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({ base_branch: from, target_branch: name }),
			},
		);
		return { name, sha: wire?.commit_sha ?? "", createdAt: new Date().toISOString() };
	}

	async deleteBranch(r: RepoRef, name: string): Promise<void> {
		await this.client.send204("/repos/branches", {
			repo: r,
			scopes: ["git:write"],
			method: "DELETE",
			contentType: "application/json",
			body: JSON.stringify({ name }),
		});
	}

	async listTags(r: RepoRef, cursor?: string): Promise<Page<TagRef>> {
		const wire = await this.client.json<WirePage & { tags: WireTag[] }>("/repos/tags", {
			repo: r,
			scopes: ["git:read"],
			query: { cursor },
		});
		return toPage(wire, wire?.tags, toTag);
	}

	async createTag(r: RepoRef, name: string, target: string): Promise<TagRef> {
		const wire = await this.client.json<{ name: string; sha: string }>("/repos/tags", {
			repo: r,
			scopes: ["git:write"],
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ name, target }),
		});
		return { name, sha: wire?.sha ?? target };
	}

	async deleteTag(r: RepoRef, name: string): Promise<void> {
		await this.client.send204("/repos/tags", {
			repo: r,
			scopes: ["git:write"],
			method: "DELETE",
			query: { name },
		});
	}

	async listCommits(
		r: RepoRef,
		o?: { branch?: string; path?: string; cursor?: string; limit?: number },
	): Promise<Page<CommitSummary>> {
		const wire = await this.client.json<WirePage & { commits: WireCommit[] }>(
			"/repos/commits",
			{
				repo: r,
				scopes: ["git:read"],
				query: {
					branch: o?.branch,
					path: o?.path,
					cursor: o?.cursor,
					limit: o?.limit,
				},
				allowNotFound: true,
			},
		);
		return toPage(wire, wire?.commits, toCommit);
	}

	async getCommit(r: RepoRef, ref: string): Promise<CommitDetail | null> {
		const wire = await this.client.json<{ commit: WireCommit }>("/repos/commit", {
			repo: r,
			scopes: ["git:read"],
			query: { sha: ref },
			allowNotFound: true,
		});
		if (!wire) return null;
		const diff = await this.client.json<WireDiff>("/repos/diff", {
			repo: r,
			scopes: ["git:read"],
			query: { sha: ref },
			allowNotFound: true,
		});
		return toCommitDetail(wire.commit, diff ? toStats(diff.stats) : null);
	}

	async getCommitDiff(
		r: RepoRef,
		ref: string,
		o?: { base?: string; paths?: string[] },
	): Promise<FileDiff[]> {
		const wire = await this.client.json<WireDiff>("/repos/diff", {
			repo: r,
			scopes: ["git:read"],
			query: { sha: ref, baseSha: o?.base, path: o?.paths?.[0] },
			allowNotFound: true,
		});
		return toFileDiffs(wire);
	}

	async compare(
		r: RepoRef,
		base: string,
		head: string,
		paths?: string[],
	): Promise<CompareResult> {
		const wire = await this.client.json<WireDiff>("/repos/branches/diff", {
			repo: r,
			scopes: ["git:read"],
			query: { branch: head, base, path: paths?.[0] },
		});
		return {
			baseSha: base,
			headSha: head,
			mergeBaseSha: wire?.merge_base_sha ?? null,
			files: toFileDiffs(wire),
			stats: toStats(wire?.stats),
		};
	}

	async listFiles(
		r: RepoRef,
		ref: string,
		o?: { path?: string; recursive?: boolean },
	): Promise<TreeEntry[]> {
		const wire = await this.client.json<WirePage & { entries: WireTreeEntry[] }>(
			"/repos/files",
			{
				repo: r,
				scopes: ["git:read"],
				query: { ref, path: o?.path, recursive: o?.recursive },
				allowNotFound: true,
			},
		);
		return (wire?.entries ?? []).map(toTreeEntry);
	}

	async listFilesWithMetadata(
		r: RepoRef,
		ref: string,
		path?: string,
	): Promise<TreeEntryWithCommit[]> {
		const wire = await this.client.json<WirePage & { files: WireTreeEntry[] }>(
			"/repos/files/metadata",
			{
				repo: r,
				scopes: ["git:read"],
				query: { ref, path },
				allowNotFound: true,
			},
		);
		return (wire?.files ?? []).map(toTreeEntryWithCommit);
	}

	async getFileContent(r: RepoRef, path: string, ref?: string): Promise<FileBlob | null> {
		const bytes = await this.client.bytes("/repos/file", {
			repo: r,
			scopes: ["git:read"],
			query: { path, ref },
			allowNotFound: true,
		});
		if (!bytes) return null;
		return {
			path,
			ref: ref ?? "HEAD",
			content: bytes,
			size: bytes.byteLength,
			binary: bytes.includes(NUL_BYTE),
		};
	}

	async getBlame(
		r: RepoRef,
		path: string,
		ref?: string,
		range?: [number, number],
	): Promise<BlameHunk[]> {
		const wire = await this.client.json<{ lines: WireBlameLine[] }>("/repos/blame", {
			repo: r,
			scopes: ["git:read"],
			query: { path, ref, range: range ? `${range[0]}-${range[1]}` : undefined },
			allowNotFound: true,
		});
		return toBlameHunks(path, wire?.lines ?? []);
	}

	async grep(r: RepoRef, pattern: string, o?: GrepOptions): Promise<Page<GrepMatch>> {
		const wire = await this.client.json<WirePage & { matches: WireGrepMatch[] }>(
			"/repos/grep",
			{
				repo: r,
				scopes: ["git:read"],
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({
					query: {
						pattern,
						case_sensitive: o?.caseSensitive ?? false,
					},
					...(o?.ref ? { rev: o.ref } : {}),
					pagination: {
						...(o?.limit ? { limit: o.limit } : {}),
						...(o?.cursor ? { cursor: o.cursor } : {}),
					},
					...(o?.contextBefore || o?.contextAfter
						? {
								context: {
									before:
										o.contextBefore ??
										0,
									after: o.contextAfter ?? 0,
								},
							}
						: {}),
				}),
				allowNotFound: true,
			},
		);
		return {
			items: toGrepMatches(wire?.matches ?? []),
			nextCursor: wire?.next_cursor ?? null,
			hasMore: wire?.has_more ?? false,
		};
	}

	async previewMerge(r: RepoRef, base: string, head: string): Promise<MergePreview> {
		const wire = await this.client.json<WireMergePreview>("/repos/merge/preview", {
			repo: r,
			scopes: ["git:read"],
			query: { source_branch: head, target_branch: base, include_content: true },
		});
		if (!wire) throw new GitError("backend_error", "merge preview returned no body");
		return {
			status: toMergeStatus(wire),
			mergeBaseSha: wire.merge_base_sha ?? null,
			baseSha: wire.target_tip_sha,
			headSha: wire.source_tip_sha,
			conflicts: toMergeConflicts(wire),
		};
	}

	async merge(r: RepoRef, base: string, head: string, o: MergeOptions): Promise<MergeResult> {
		const squash = o.strategy === "squash";
		try {
			const wire = await this.client.json<WireMergeResult>("/repos/merge", {
				repo: r,
				scopes: ["git:write"],
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify({
					source_branch: head,
					target_branch: base,
					strategy: o.strategy === "rebase" ? "rebase" : "merge",
					squash,
					commit_message: o.message ?? `Merge ${head} into ${base}`,
					author: { name: o.author.name, email: o.author.email },
					...(o.expectedBaseSha
						? { expected_target_sha: o.expectedBaseSha }
						: {}),
				}),
			});
			const sha = wire?.target?.new_sha ?? wire?.commit_sha ?? null;
			return {
				merged: wire?.result !== "no_op",
				sha,
				status: wire?.result === "no_op" ? "up_to_date" : "clean",
				conflicts: [],
			};
		} catch (error) {
			if (error instanceof GitError && error.code === "conflict") {
				const preview = await this.previewMerge(r, base, head);
				return {
					merged: false,
					sha: null,
					status: "conflicted",
					conflicts: preview.conflicts,
				};
			}
			throw error;
		}
	}

	async commitFiles(r: RepoRef, i: CommitFilesInput): Promise<CommitSummary> {
		const metadata = {
			metadata: {
				target_branch: i.branch,
				commit_message: i.message,
				author: { name: i.author.name, email: i.author.email },
				...(i.expectedHeadSha
					? { expected_head_sha: i.expectedHeadSha }
					: {}),
				// Deletions carry no content_id: the backend rejects an id it will
				// never receive a blob chunk for.
				files: i.files.map((file, index) =>
					file.deleted
						? { path: file.path, operation: "delete" }
						: {
								path: file.path,
								operation: "upsert",
								content_id: `b${index}`,
								mode: file.mode ?? "100644",
							},
				),
			},
		};
		const chunks = i.files.flatMap((file, index) =>
			file.deleted
				? []
				: [
						{
							blob_chunk: {
								content_id: `b${index}`,
								data: encodeBase64(
									toBytes(file.content ?? ""),
								),
								eof: true,
							},
						},
					],
		);
		const wire = await this.client.ndjson<{ commit: { commit_sha: string } }>(
			"/repos/commit-pack",
			r,
			[metadata, ...chunks],
		);
		return this.readCommit(r, wire.commit.commit_sha, i);
	}

	async commitPatch(r: RepoRef, i: CommitPatchInput): Promise<CommitSummary> {
		const wire = await this.client.ndjson<{ commit: { commit_sha: string } }>(
			"/repos/diff-commit",
			r,
			[
				{
					metadata: {
						target_branch: i.branch,
						commit_message: i.message,
						author: {
							name: i.author.name,
							email: i.author.email,
						},
						...(i.expectedHeadSha
							? { expected_head_sha: i.expectedHeadSha }
							: {}),
					},
				},
				{ diff_chunk: { data: encodeBase64(toBytes(i.patch)), eof: true } },
			],
		);
		return this.readCommit(r, wire.commit.commit_sha, i);
	}

	async getArchiveStream(r: RepoRef, ref: string): Promise<ReadableStream<Uint8Array>> {
		return this.client.stream("/repos/archive", {
			repo: r,
			scopes: ["git:read"],
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ ref }),
		});
	}

	async getRemoteUrl(r: RepoRef, scopes: GitScope[], ttlSeconds: number): Promise<string> {
		return this.client.remoteUrl(r, toCodeStorageScopes(scopes), ttlSeconds);
	}

	/** Commit endpoints return only the SHA; the UI needs the full summary. */
	private async readCommit(
		r: RepoRef,
		sha: string,
		input: { message: string; author: { name: string; email: string } },
	): Promise<CommitSummary> {
		const detail = await this.getCommit(r, sha);
		return (
			detail ?? {
				sha,
				message: input.message,
				parents: [],
				author: input.author,
				committer: input.author,
				date: new Date().toISOString(),
			}
		);
	}
}
