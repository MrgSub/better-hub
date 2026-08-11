import { CodeStorageProvider } from "./code-storage/provider";
import type { GitProvider } from "./provider";
import { GitError } from "./types";

export type GitBackend = "code-storage";

const DEFAULT_BACKEND: GitBackend = "code-storage";

const factories: Record<GitBackend, () => GitProvider> = {
	"code-storage": () => new CodeStorageProvider(),
};

const instances = new Map<GitBackend, GitProvider>();

function parseBackend(value: string | undefined): GitBackend {
	if (!value) return DEFAULT_BACKEND;
	if (value in factories) return value as GitBackend;
	throw new GitError("backend_error", `GIT_BACKEND "${value}" is not a known git backend`);
}

/**
 * Resolves the git backend for a repository.
 *
 * `backend` comes from `Repository.gitBackend` when the caller knows it, so
 * repositories can live on different backends inside one deployment; otherwise
 * the deployment default `GIT_BACKEND` applies. Instances are memoized because
 * adapters hold a cached signing key.
 */
export function getGitProvider(backend?: GitBackend): GitProvider {
	const selected = backend ?? parseBackend(process.env.GIT_BACKEND);
	const existing = instances.get(selected);
	if (existing) return existing;
	const created = factories[selected]();
	instances.set(selected, created);
	return created;
}

export type { GitProvider } from "./provider";
export * from "./types";
