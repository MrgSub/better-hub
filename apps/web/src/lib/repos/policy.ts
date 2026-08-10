/**
 * Who may import a GitHub repository, and what a second importer of the same
 * repository gets. The rules mirror GitHub's own: anyone who can read a repo
 * may fork it, only an admin may move an organization's repo, and a personal
 * repo belongs to the account it lives under.
 *
 * Pure on purpose — the caller supplies what GitHub said and what we already
 * store, so the decision is unit-testable without a database or a token.
 */

export type UpstreamPermission = "admin" | "write" | "read";

export interface UpstreamOwnership {
	owner: string;
	ownerType: "User" | "Organization";
	/** The signed-in user's permission on the upstream repository. */
	permission: UpstreamPermission;
}

export type ImportDecision =
	/** Nobody has imported this upstream yet and the actor may claim it. */
	| { kind: "create"; owner: string }
	/** Someone already imported it and the actor may write to it. */
	| { kind: "join"; permission: UpstreamPermission }
	/** The actor may only read, so they get their own copy instead. */
	| { kind: "fork"; owner: string; source: "canonical" | "upstream" };

export function toUpstreamPermission(
	permissions: { admin?: boolean; push?: boolean } | undefined,
): UpstreamPermission {
	if (permissions?.admin) return "admin";
	if (permissions?.push) return "write";
	return "read";
}

/**
 * Repositories live under the upstream's namespace so that the canonical copy
 * of `vercel/next.js` is the same repo for everyone; forks live under the
 * forker's own login, exactly like GitHub.
 */
export function decideImport(input: {
	upstream: UpstreamOwnership;
	actorLogin: string;
	/** True when we already hold a repository imported from this upstream. */
	canonicalExists: boolean;
}): ImportDecision {
	const { upstream, actorLogin, canonicalExists } = input;

	if (canonicalExists) {
		return upstream.permission === "read"
			? { kind: "fork", owner: actorLogin, source: "canonical" }
			: { kind: "join", permission: upstream.permission };
	}

	const mayClaim =
		upstream.ownerType === "Organization"
			? upstream.permission === "admin"
			: upstream.owner.toLowerCase() === actorLogin.toLowerCase();

	return mayClaim
		? { kind: "create", owner: upstream.owner }
		: { kind: "fork", owner: actorLogin, source: "upstream" };
}
