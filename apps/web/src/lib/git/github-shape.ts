import type { CommitSummary, FileDiff, RepoRef } from "./types";

/**
 * Backend values in the REST shapes the pages already read.
 *
 * Both the repository and the pull request readers answer with GitHub's field
 * names so nothing above them branches on where the bytes came from; the
 * translation lives here once instead of in each of them.
 */

/** GitHub spells out what git abbreviates to a letter. */
const FILE_STATUS: Record<FileDiff["status"], string> = {
	A: "added",
	M: "modified",
	D: "removed",
	R: "renamed",
	C: "copied",
	T: "changed",
};

/**
 * The backends report a diff as a patch without per-file totals, and the pages
 * render those totals, so they are counted here rather than stored per file.
 */
export function patchStats(patch: string | null): { additions: number; deletions: number } {
	if (!patch) return { additions: 0, deletions: 0 };
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { additions, deletions };
}

export function githubFiles(files: FileDiff[], sha: string) {
	return files.map((file) => {
		const stats = patchStats(file.patch);
		return {
			filename: file.path,
			status: FILE_STATUS[file.status],
			additions: stats.additions,
			deletions: stats.deletions,
			changes: stats.additions + stats.deletions,
			patch: file.patch ?? undefined,
			sha,
			blob_url: "",
			raw_url: "",
			contents_url: "",
		};
	});
}

/**
 * A commit as `repos.listCommits` returns it. The `author`/`committer` slots
 * stay null: they are GitHub accounts, and a commit here only carries the
 * name and email git recorded.
 */
export function githubCommit(c: CommitSummary, r: RepoRef) {
	return {
		sha: c.sha,
		node_id: c.sha,
		url: "",
		html_url: `/${r.owner}/${r.repo}/commits/${c.sha}`,
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
	};
}
