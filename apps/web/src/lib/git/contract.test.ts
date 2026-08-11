import { describe } from "vitest";
import { CodeStorageProvider } from "./code-storage/provider";
import { runGitProviderContract } from "./contract";

/**
 * The contract suite talks to a real backend, so it runs only where that
 * backend is configured. CI without credentials reports it as skipped rather
 * than passing vacuously.
 */
const codeStorageConfigured = Boolean(
	process.env.PIERRE_STORAGE_NAME && process.env.PIERRE_STORAGE_KEY,
);

describe.skipIf(!codeStorageConfigured)("code-storage", () => {
	runGitProviderContract("code-storage", () => new CodeStorageProvider());
});
