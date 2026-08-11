import type { Repository } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { UpstreamRef } from "@/lib/git/types";
import { upstreamCoordinates } from "./upstream-metadata";

/**
 * Keeping the GitHub repository a mirror of ours, so the Actions, deploy hooks
 * and integrations still wired to it keep firing after we become the upstream.
 *
 * We push nothing ourselves. A backend that syncs a repository with an external
 * host forwards the refs written to it, which makes mirroring a property of the
 * upstream link — fixed when the repository is created, hence chosen at import
 * and not a switch on the settings page. Our part is to record the choice and
 * to say what the backend's last sync run did.
 *
 * Only refs are mirrored. Issues stay GitHub's, pull requests are ours, and
 * neither is a git object; mirroring them would mean writing them upstream as a
 * bot and reconciling two sets of numbers, so it is deliberately out of scope.
 */

export type MirrorMode = "off" | "refs";
export type MirrorState = "syncing" | "synced" | "failed";

/**
 * How the backend must authenticate to the upstream for the requested mirror
 * mode. Forwarding writes needs the GitHub App installation: a public upstream
 * is readable anonymously but not writable, and the stored-credential path is
 * a one-way import of someone's own token.
 */
export function mirrorUpstreamAuth(
	mode: MirrorMode,
	isPrivate: boolean,
): NonNullable<UpstreamRef["auth"]> {
	if (mode === "refs") return "installation";
	return isPrivate ? "token" : "public";
}

export interface MirrorStatus {
	mode: MirrorMode;
	state: MirrorState | null;
	error: string | null;
	syncedAt: Date | null;
	/** The GitHub repository being mirrored, when there is one. */
	upstream: { owner: string; repo: string; url: string } | null;
}

export function mirrorStatus(record: Repository): MirrorStatus {
	const upstream = upstreamCoordinates(record);
	return {
		mode: record.mirrorMode === "refs" ? "refs" : "off",
		state: toState(record.mirrorState),
		error: record.mirrorError,
		syncedAt: record.mirrorSyncedAt,
		upstream: upstream
			? {
					...upstream,
					url: `https://github.com/${upstream.owner}/${upstream.repo}`,
				}
			: null,
	};
}

function toState(raw: string | null): MirrorState | null {
	return raw === "syncing" || raw === "synced" || raw === "failed" ? raw : null;
}

/**
 * A push the backend saw, which we count as activity on the repository.
 *
 * The remotes we mint are usable without going through the app — an agent or a
 * clone pushes straight to the backend — so this is the only thing that dates a
 * repository whose writes never passed through us.
 */
export async function recordMirrorPush(gitRepoId: string, at: Date): Promise<void> {
	await prisma.repository.updateMany({
		where: { gitRepoId },
		data: { updatedAt: at },
	});
}

/**
 * A sync run the backend reported. Repositories are addressed by the id the
 * backend assigned them, since that is the only name it knows them by and a
 * display rename does not move it.
 */
export interface MirrorSyncEvent {
	gitRepoId: string;
	state: MirrorState;
	/** Present on failures only. */
	error?: string | null;
	at: Date;
}

/**
 * Records a sync run against whichever repository the backend id belongs to.
 *
 * A repository that is not mirroring still gets its run recorded: the first
 * sync of an import is one, and seeing it fail is how the import reports that
 * the upstream was unreachable.
 */
export async function recordMirrorSync(event: MirrorSyncEvent): Promise<void> {
	await prisma.repository.updateMany({
		where: { gitRepoId: event.gitRepoId },
		data: {
			mirrorState: event.state,
			mirrorError:
				event.state === "failed" ? (event.error ?? "sync failed") : null,
			...(event.state === "synced" ? { mirrorSyncedAt: event.at } : {}),
		},
	});
}
