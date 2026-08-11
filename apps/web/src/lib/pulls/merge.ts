import type { PullRequest } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { MergeConflict, MergeStrategy as ProviderMergeStrategy } from "@/lib/git/types";
import type { HostedRepo } from "@/lib/repos/hosted-source";
import { RepoBusyError, withRepoLock } from "@/lib/repos/lock";
import { writeRefusal } from "@/lib/repos/registry";
import type { PullAuthor } from "./create";

/**
 * Landing a pull request we own.
 *
 * The record is ours and the refs are the backend's, so merging is three steps
 * that must not drift apart: prove the branches still look the way the reviewer
 * saw them, move the ref through `GitProvider`, then write the outcome down.
 * Concurrent merges into one branch are serialised on a repository lease, and
 * the backend is additionally given the base sha we expect — so a merge racing
 * another one is refused rather than silently built on a tree nobody reviewed.
 * The lease only queues the callers; the expected sha is what makes the race
 * safe, which matters because no lock can be held across a backend that has
 * already moved a ref.
 */

export type MergeStrategy = "merge" | "squash" | "rebase";

export interface MergePullInput {
	number: number;
	strategy?: MergeStrategy;
	title?: string;
	message?: string;
	/** Mirrors GitHub's checkbox; ignored for a branch another pull request stacks on. */
	deleteBranch?: boolean;
}

export type MergePullResult =
	| { ok: true; sha: string | null; restacked: RestackOutcome[] }
	| { ok: false; error: string; conflicts?: MergeConflict[] };

export interface RestackOutcome {
	number: number;
	status: "restacked" | "conflicted" | "up_to_date";
}

/**
 * What to ask the backend for. A rebase is only requested from a backend that
 * really rebases; anywhere else the closest honest thing is a fast-forward,
 * and the caller above tells the user which one they are getting.
 */
function providerStrategy(h: HostedRepo, strategy: MergeStrategy): ProviderMergeStrategy {
	if (strategy !== "rebase") return strategy;
	return h.git.mergeStrategies.includes("rebase") ? "rebase" : "fast_forward";
}

/** Whether this repository can offer "Rebase and merge" at all. */
export function hostedMergeMethods(h: HostedRepo): {
	merge: boolean;
	squash: boolean;
	rebase: boolean;
} {
	const strategies = h.git.mergeStrategies;
	return {
		merge: strategies.includes("merge"),
		squash: strategies.includes("squash"),
		// A fast-forward is not a rebase, so it is not offered as one.
		rebase: strategies.includes("rebase"),
	};
}

function gitActor(actor: PullAuthor) {
	const login = actor.login ?? "better-hub";
	return {
		name: actor.name ?? login,
		email: `${login}@users.noreply.better-hub.com`,
	};
}

/**
 * The pull request's number belongs on the subject line exactly once: the merge
 * sheet prefills the title with it, so appending unconditionally would land
 * `Title (#4) (#4)`.
 */
function mergeMessage(pull: PullRequest, input: MergePullInput): string {
	const title = input.title?.trim() || pull.title;
	const suffix = `(#${pull.number})`;
	const subject = title.endsWith(suffix) ? title : `${title} ${suffix}`;
	const body = input.message?.trim() || pull.bodyMd?.trim() || "";
	return body ? `${subject}\n\n${body}` : subject;
}

async function openPull(repositoryId: string, number: number): Promise<PullRequest | null> {
	return prisma.pullRequest.findFirst({ where: { repositoryId, number } });
}

export async function mergeHostedPull(
	h: HostedRepo,
	actor: PullAuthor,
	input: MergePullInput,
): Promise<MergePullResult> {
	const refusal = await writeRefusal(h.record, actor.userId);
	if (refusal) return { ok: false, error: refusal };

	const strategy = input.strategy ?? "merge";

	try {
		return await withRepoLock(h.record.id, async () => {
			const pull = await openPull(h.record.id, input.number);
			if (!pull) return { ok: false, error: "Pull request not found" };
			if (pull.state !== "open")
				return { ok: false, error: "This pull request is not open" };
			if (pull.draft)
				return {
					ok: false,
					error: "A draft pull request cannot be merged",
				};

			// The reviewer approved a particular head; if it moved since, the diff
			// on screen is not the diff that would land.
			const branches = await h.git.listBranches(h.ref);
			const head = branches.items.find((b) => b.name === pull.headBranch);
			const base = branches.items.find((b) => b.name === pull.baseBranch);
			if (!head)
				return {
					ok: false,
					error: `Branch ${pull.headBranch} no longer exists`,
				};
			if (!base)
				return {
					ok: false,
					error: `Branch ${pull.baseBranch} no longer exists`,
				};

			if (head.sha !== pull.headSha) {
				// Record the new tip so the page the reviewer reloads shows the diff
				// that would now land, then let them merge that one deliberately.
				await prisma.pullRequest.update({
					where: { id: pull.id },
					data: { headSha: head.sha },
				});
				return {
					ok: false,
					error: `${pull.headBranch} has new commits since this diff was loaded — review them and merge again`,
				};
			}

			const preview = await h.git.previewMerge(
				h.ref,
				pull.baseBranch,
				pull.headBranch,
			);
			// A recorded resolution is a branch off the base carrying the merged tree,
			// so it is what lands when the head itself cannot.
			const source = await mergeSource(h, pull, preview.status === "conflicted");
			if (!source) {
				await recordConflict(pull, actor, preview.conflicts);
				return {
					ok: false,
					error: `${pull.headBranch} conflicts with ${pull.baseBranch}`,
					conflicts: preview.conflicts,
				};
			}

			// A backend with no rebase primitive performs a fast-forward
			// instead: also linear, but only possible once the head already
			// carries the base — and refused, rather than quietly turned into
			// a merge commit, when it does not.
			const wireStrategy = providerStrategy(h, strategy);
			if (wireStrategy === "fast_forward" && preview.mergeBaseSha !== base.sha) {
				return {
					ok: false,
					error: `${pull.headBranch} is behind ${pull.baseBranch} — update the branch first: ${h.git.backend} can only fast-forward, not rebase`,
				};
			}

			// Counted before the restack re-targets the children off this branch.
			const stackedOnHead = await prisma.pullRequest.count({
				where: {
					repositoryId: h.record.id,
					state: "open",
					baseBranch: pull.headBranch,
					id: { not: pull.id },
				},
			});

			const result = await h.git.merge(h.ref, pull.baseBranch, source, {
				author: gitActor(actor),
				strategy: wireStrategy,
				message: mergeMessage(pull, input),
				expectedBaseSha: base.sha,
			});
			if (!result.merged && result.status === "conflicted") {
				await recordConflict(pull, actor, result.conflicts);
				return {
					ok: false,
					error: `${pull.headBranch} conflicts with ${pull.baseBranch}`,
					conflicts: result.conflicts,
				};
			}

			if (source !== pull.headBranch) {
				await h.git.deleteBranch(h.ref, source).catch(() => {});
			}

			const merged = await prisma.pullRequest.update({
				where: { id: pull.id },
				data: {
					state: "merged",
					mergeSha: result.sha,
					headSha: head.sha,
					baseSha: result.sha ?? base.sha,
					mergedAt: new Date(),
					mergedById: actor.userId,
					closedAt: new Date(),
					resolutionBranch: null,
					resolutionSha: null,
					events: {
						create: {
							kind: "merged",
							actorId: actor.userId,
							actorLogin: actor.login,
							payloadJson: JSON.stringify({
								strategy,
								sha: result.sha,
								headSha: head.sha,
								...(source === pull.headBranch
									? {}
									: {
											resolvedBy: pull.resolutionBy,
										}),
							}),
						},
					},
				},
			});

			const restacked = await restackChildren(h, actor, merged, pull.baseBranch);

			// A branch another pull request was stacked on has to outlive this merge:
			// a child that failed to restack is still explained by it, and one that
			// succeeded may still be checked out by a reviewer.
			if (input.deleteBranch && stackedOnHead === 0) {
				await h.git.deleteBranch(h.ref, pull.headBranch).catch(() => {});
			}

			return { ok: true, sha: result.sha, restacked };
		});
	} catch (e) {
		// Queuing behind another merge is an outcome the sheet can explain, not
		// a crash.
		if (e instanceof RepoBusyError) return { ok: false, error: e.message };
		throw e;
	}
}

/** Branch names are derived, so a repeated attempt reuses one name per tip. */
export function resolutionBranchName(number: number, headSha: string): string {
	return `bh/resolve/${number}-${headSha.slice(0, 12)}`;
}

/**
 * What actually gets merged: the head branch, or a resolution branch we already
 * proved merges cleanly. A resolution is only usable while the base still points
 * where it did when the resolution was cut, so a moved base drops it.
 */
async function mergeSource(
	h: HostedRepo,
	pull: PullRequest,
	conflicted: boolean,
): Promise<string | null> {
	if (!conflicted) return pull.headBranch;
	if (!pull.resolutionBranch) return null;
	// The branch name carries the tip it was resolved from, so a head that moved
	// since cannot be merged through a resolution that predates its commits.
	const stale = pull.resolutionBranch !== resolutionBranchName(pull.number, pull.headSha);

	const preview = stale
		? null
		: await h.git
				.previewMerge(h.ref, pull.baseBranch, pull.resolutionBranch)
				.catch(() => null);
	if (!preview || preview.status === "conflicted") {
		await h.git.deleteBranch(h.ref, pull.resolutionBranch).catch(() => {});
		await prisma.pullRequest.update({
			where: { id: pull.id },
			data: { resolutionBranch: null, resolutionSha: null, resolutionBy: null },
		});
		return null;
	}
	return pull.resolutionBranch;
}

async function recordConflict(
	pull: PullRequest,
	actor: PullAuthor,
	conflicts: MergeConflict[],
): Promise<void> {
	await prisma.pullRequestEvent.create({
		data: {
			pullRequestId: pull.id,
			kind: "conflicted",
			actorId: actor.userId,
			actorLogin: actor.login,
			payloadJson: JSON.stringify({ paths: conflicts.map((c) => c.path) }),
		},
	});
}

/**
 * A stack is only usable if merging its bottom does not leave everything above
 * it pointing at a branch that no longer explains the diff.
 *
 * A direct child is the only one whose base moves: the branch it was stacked on
 * is gone, so it re-targets what its parent merged into. Everything deeper keeps
 * its base — that branch still exists — and only needs the new commits carried
 * up. Both are the same primitive: merge the base into the head. The backend has
 * no way to rewrite someone else's branch, so this is a merge rather than a true
 * rebase, which also means no force push and a reviewer's checkout stays valid.
 *
 * A conflict stops that limb only: the pull request stays open, flagged for
 * resolution, and its own children are left alone rather than carried onto a
 * tree that is now wrong.
 */
async function restackChildren(
	h: HostedRepo,
	actor: PullAuthor,
	parent: PullRequest,
	/** Set only for the merged pull request's own children. */
	newBase?: string,
): Promise<RestackOutcome[]> {
	const children = await prisma.pullRequest.findMany({
		where: { repositoryId: h.record.id, parentId: parent.id, state: "open" },
	});
	const outcomes: RestackOutcome[] = [];

	for (const child of children) {
		const base = newBase ?? child.baseBranch;
		const result = await h.git
			.merge(h.ref, child.headBranch, base, {
				author: gitActor(actor),
				strategy: "merge",
				message: `Restack ${child.headBranch} onto ${base} after #${parent.number}`,
			})
			.catch(() => null);

		if (!result || (!result.merged && result.status === "conflicted")) {
			await prisma.pullRequest.update({
				where: { id: child.id },
				data: {
					baseBranch: base,
					events: {
						create: {
							kind: "restack_conflicted",
							actorId: actor.userId,
							actorLogin: actor.login,
							payloadJson: JSON.stringify({
								base,
								paths: (
									result?.conflicts ?? []
								).map((c) => c.path),
							}),
						},
					},
				},
			});
			outcomes.push({ number: child.number, status: "conflicted" });
			continue;
		}

		const restacked = await prisma.pullRequest.update({
			where: { id: child.id },
			data: {
				baseBranch: base,
				headSha: result.sha ?? child.headSha,
				// For a direct child that is the parent's merge commit; deeper up
				// the stack it is the branch tip the merge just read.
				baseSha:
					(newBase ? parent.mergeSha : parent.headSha) ??
					child.baseSha,
				events: {
					create: {
						kind: "rebased",
						actorId: actor.userId,
						actorLogin: actor.login,
						payloadJson: JSON.stringify({
							base,
							sha: result.sha,
						}),
					},
				},
			},
		});
		outcomes.push({
			number: child.number,
			status: result.status === "up_to_date" ? "up_to_date" : "restacked",
		});
		outcomes.push(...(await restackChildren(h, actor, restacked)));
	}

	return outcomes;
}

/**
 * GitHub's "Update branch": bring the base's commits into the head so the
 * reviewer sees the diff that would actually land. Same primitive as a restack,
 * which is why it reports conflicts the same way.
 */
export async function updateHostedPullBranch(
	h: HostedRepo,
	actor: PullAuthor,
	number: number,
): Promise<{ ok: true; sha: string | null } | { ok: false; error: string }> {
	const refusal = await writeRefusal(h.record, actor.userId);
	if (refusal) return { ok: false, error: refusal };

	const pull = await openPull(h.record.id, number);
	if (!pull) return { ok: false, error: "Pull request not found" };
	if (pull.state !== "open") return { ok: false, error: "This pull request is not open" };

	// Moves the head ref, so it queues behind a merge of the same repository.
	const result = await withRepoLock(h.record.id, () =>
		h.git.merge(h.ref, pull.headBranch, pull.baseBranch, {
			author: gitActor(actor),
			strategy: "merge",
			message: `Merge ${pull.baseBranch} into ${pull.headBranch}`,
		}),
	).catch((e: unknown) => {
		if (e instanceof RepoBusyError) return null;
		throw e;
	});
	if (!result) {
		return { ok: false, error: "Another write to this repository is in progress" };
	}
	if (!result.merged && result.status === "conflicted") {
		await recordConflict(pull, actor, result.conflicts);
		return { ok: false, error: `${pull.baseBranch} conflicts with ${pull.headBranch}` };
	}

	await prisma.pullRequest.update({
		where: { id: pull.id },
		data: {
			headSha: result.sha ?? pull.headSha,
			events: {
				create: {
					kind: "pushed",
					actorId: actor.userId,
					actorLogin: actor.login,
					payloadJson: JSON.stringify({
						sha: result.sha,
						from: pull.baseBranch,
					}),
				},
			},
		},
	});
	return { ok: true, sha: result.sha };
}

export async function setHostedPullState(
	h: HostedRepo,
	actor: PullAuthor,
	number: number,
	state: "open" | "closed",
): Promise<{ ok: true } | { ok: false; error: string }> {
	const refusal = await writeRefusal(h.record, actor.userId);
	if (refusal) return { ok: false, error: refusal };

	const pull = await openPull(h.record.id, number);
	if (!pull) return { ok: false, error: "Pull request not found" };
	if (pull.state === "merged") return { ok: false, error: "This pull request is merged" };

	await prisma.pullRequest.update({
		where: { id: pull.id },
		data: {
			state,
			closedAt: state === "closed" ? new Date() : null,
			events: {
				create: {
					kind: state === "closed" ? "closed" : "reopened",
					actorId: actor.userId,
					actorLogin: actor.login,
				},
			},
		},
	});
	return { ok: true };
}
