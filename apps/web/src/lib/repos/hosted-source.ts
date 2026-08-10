import { cache } from "react";
import { getGitProvider, type GitBackend } from "@/lib/git";
import type { GitProvider } from "@/lib/git/provider";
import type { RepoRef } from "@/lib/git/types";
import { findRepository } from "./registry";

/**
 * Serves code reads from the repository's own git backend instead of GitHub.
 *
 * Payloads keep the GitHub REST shapes `lib/github.ts` already returns so the
 * pages rendering them stay untouched: the only difference is where the bytes
 * came from, which is what keeps browsing alive during a GitHub outage.
 */

export interface HostedRepo {
	ref: RepoRef;
	git: GitProvider;
	defaultBranch: string;
}

/**
 * Resolves a repository we host, or null when GitHub is still its home.
 * Cached per request because every code read asks first.
 */
export const hostedRepo = cache(async (owner: string, name: string): Promise<HostedRepo | null> => {
	const record = await findRepository(owner, name);
	if (!record) return null;
	return {
		ref: { owner: record.owner, repo: record.name },
		git: getGitProvider(record.gitBackend as GitBackend),
		defaultBranch: record.defaultBranch,
	};
});

export async function hostedTree(h: HostedRepo, ref: string, recursive: boolean) {
	const entries = await h.git.listFiles(h.ref, ref, { recursive });
	return {
		sha: ref,
		url: "",
		truncated: false,
		tree: entries.map((e) => ({
			path: e.path,
			mode: e.mode,
			type: e.type,
			size: e.size ?? undefined,
			sha: "",
			url: "",
		})),
	};
}

export async function hostedBranches(h: HostedRepo) {
	const page = await h.git.listBranches(h.ref);
	return page.items.map((b) => ({
		name: b.name,
		commit: { sha: b.sha, url: "" },
		protected: false,
	}));
}

export async function hostedTags(h: HostedRepo) {
	const page = await h.git.listTags(h.ref);
	return page.items.map((t) => ({
		name: t.name,
		commit: { sha: t.sha, url: "" },
		zipball_url: "",
		tarball_url: "",
		node_id: t.sha,
	}));
}

/** Directory listing; a file path returns the single entry GitHub would. */
export async function hostedContents(h: HostedRepo, path: string, ref?: string) {
	const at = ref || h.defaultBranch;
	const entries = await h.git.listFiles(h.ref, at, { path });
	return entries.map((e) => ({
		name: e.path.split("/").pop() ?? e.path,
		path: e.path,
		sha: "",
		size: e.size ?? 0,
		type: e.type === "tree" ? ("dir" as const) : ("file" as const),
		url: "",
		html_url: `/${h.ref.owner}/${h.ref.repo}/tree/${at}/${e.path}`,
		git_url: "",
		download_url: null,
	}));
}

export async function hostedFileContent(h: HostedRepo, path: string, ref?: string) {
	// A directory is not a file: GitHub answers 404, and the backends reject
	// the empty path outright.
	if (!path) return null;

	const at = ref || h.defaultBranch;
	const blob = await h.git.getFileContent(h.ref, path, at);
	if (!blob) return null;
	return {
		name: path.split("/").pop() ?? path,
		path,
		sha: "",
		size: blob.size,
		type: "file" as const,
		encoding: "utf-8",
		// Decoded even when binary, so the control bytes the viewer sniffs for
		// survive and it shows a download instead of an empty file.
		content: new TextDecoder().decode(blob.content),
		url: "",
		html_url: `/${h.ref.owner}/${h.ref.repo}/blob/${at}/${path}`,
		git_url: "",
		download_url: null,
	};
}

/**
 * Page-numbered like the GitHub call it replaces; the backend is cursored, so
 * earlier pages are walked and discarded.
 */
export async function hostedCommits(
	h: HostedRepo,
	branch: string | undefined,
	page: number,
	perPage: number,
) {
	let cursor: string | undefined;
	let items = [] as Awaited<ReturnType<GitProvider["listCommits"]>>["items"];
	for (let i = 1; i <= page; i++) {
		const result = await h.git.listCommits(h.ref, {
			...(branch ? { branch } : {}),
			limit: perPage,
			...(cursor ? { cursor } : {}),
		});
		items = result.items;
		if (!result.hasMore || !result.nextCursor) {
			if (i < page) return [];
			break;
		}
		cursor = result.nextCursor;
	}
	return items.map((c) => ({
		sha: c.sha,
		node_id: c.sha,
		url: "",
		html_url: `/${h.ref.owner}/${h.ref.repo}/commits/${c.sha}`,
		comments_url: "",
		commit: {
			message: c.message,
			author: { name: c.author.name, email: c.author.email, date: c.date },
			committer: {
				name: c.committer.name,
				email: c.committer.email,
				date: c.date,
			},
			comment_count: 0,
			url: "",
		},
		author: null,
		committer: null,
		parents: c.parents.map((sha) => ({ sha, url: "", html_url: "" })),
	}));
}
