import { describe, expect, it } from "vitest";
import {
	normalizePrivateKeyPem,
	readCodeStorageConfig,
	repoId,
	toCodeStorageScopes,
} from "./client";
import { GitError } from "../types";

const BODY = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg" + "A".repeat(80);
const PEM = `-----BEGIN PRIVATE KEY-----\n${BODY.slice(0, 64)}\n${BODY.slice(64)}\n-----END PRIVATE KEY-----\n`;

describe("normalizePrivateKeyPem", () => {
	it("passes a well-formed key through unchanged", () => {
		expect(normalizePrivateKeyPem(PEM)).toBe(PEM);
	});

	it("restores escaped newlines from a single-line env value", () => {
		expect(normalizePrivateKeyPem(PEM.replaceAll("\n", "\\n"))).toBe(PEM);
	});

	it("re-wraps a key whose newlines became spaces", () => {
		expect(normalizePrivateKeyPem(PEM.replaceAll("\n", " "))).toBe(PEM);
	});

	it("strips wrapping quotes", () => {
		expect(normalizePrivateKeyPem(`"${PEM}"`)).toBe(PEM);
	});

	it("rejects a value that is not a PEM block", () => {
		expect(() => normalizePrivateKeyPem("not-a-key")).toThrow(GitError);
	});
});

describe("readCodeStorageConfig", () => {
	const env = { PIERRE_STORAGE_NAME: "orchid", PIERRE_STORAGE_KEY: PEM };

	it("derives the git host from the org name", () => {
		expect(readCodeStorageConfig(env).gitHost).toBe("orchid.code.storage");
	});

	it("fails fast when the backend is selected but unconfigured", () => {
		expect(() => readCodeStorageConfig({ PIERRE_STORAGE_KEY: PEM })).toThrow(
			/PIERRE_STORAGE_NAME/,
		);
		expect(() => readCodeStorageConfig({ PIERRE_STORAGE_NAME: "orchid" })).toThrow(
			/PIERRE_STORAGE_KEY/,
		);
	});
});

describe("toCodeStorageScopes", () => {
	it("always grants read and escalates only as asked", () => {
		expect(toCodeStorageScopes(["read"])).toEqual(["git:read"]);
		expect(toCodeStorageScopes(["write"])).toEqual(["git:read", "git:write"]);
		expect(toCodeStorageScopes(["admin"])).toEqual([
			"git:read",
			"git:write",
			"repo:write",
		]);
	});
});

describe("repoId", () => {
	it("joins owner and repo the way the JWT claim expects", () => {
		expect(repoId({ owner: "better-hub", repo: "web" })).toBe("better-hub/web");
	});
});
