import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@/generated/prisma/client";

vi.mock("@/lib/auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/repos/hosted-source", () => ({ hostedRepo: vi.fn() }));
vi.mock("@/lib/repos/registry", () => ({ repositoryPermission: vi.fn() }));

import { getServerSession } from "@/lib/auth";
import { hostedRepo } from "@/lib/repos/hosted-source";
import { repositoryPermission } from "@/lib/repos/registry";
import { GET } from "./[owner]/[repo]/[...path]/route";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);

function hosted(overrides: Partial<Repository> = {}, content = png) {
	return {
		ref: { owner: "adam", repo: "hello" },
		defaultBranch: "main",
		record: {
			id: "repo_1",
			owner: "adam",
			name: "hello",
			isPrivate: false,
			...overrides,
		},
		git: {
			getFileContent: vi.fn().mockResolvedValue({
				path: "logo.png",
				ref: "main",
				content,
				size: content.length,
				binary: true,
			}),
		},
	};
}

function request(path = "/api/raw/adam/hello/logo.png") {
	return new NextRequest(new URL(path, "https://orkd.ai"));
}

function params(path: string[]) {
	return { params: Promise.resolve({ owner: "adam", repo: "hello", path }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getServerSession).mockResolvedValue(null as never);
});

describe("raw file route", () => {
	it("streams the bytes unchanged, so a binary survives the round trip", async () => {
		vi.mocked(hostedRepo).mockResolvedValue(hosted() as never);

		const response = await GET(request(), params(["logo.png"]));
		const body = new Uint8Array(await response.arrayBuffer());

		expect(response.status).toBe(200);
		expect(body).toEqual(png);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("never types a file the browser could execute", async () => {
		vi.mocked(hostedRepo).mockResolvedValue(hosted() as never);
		const response = await GET(request(), params(["evil.svg"]));
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
	});

	it("is a 404 for a repository we do not host", async () => {
		vi.mocked(hostedRepo).mockResolvedValue(null);
		expect((await GET(request(), params(["logo.png"]))).status).toBe(404);
	});

	it("does not serve a private repository to someone with no access", async () => {
		const repo = hosted({ isPrivate: true });
		vi.mocked(hostedRepo).mockResolvedValue(repo as never);
		vi.mocked(repositoryPermission).mockResolvedValue(null);

		expect((await GET(request(), params(["logo.png"]))).status).toBe(404);
		expect(repo.git.getFileContent).not.toHaveBeenCalled();
	});

	it("serves a private repository to a collaborator", async () => {
		vi.mocked(hostedRepo).mockResolvedValue(hosted({ isPrivate: true }) as never);
		vi.mocked(repositoryPermission).mockResolvedValue("read");

		const response = await GET(request(), params(["logo.png"]));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("reads the ref the caller asked for, defaulting to the default branch", async () => {
		const repo = hosted();
		vi.mocked(hostedRepo).mockResolvedValue(repo as never);

		await GET(
			request("/api/raw/adam/hello/docs/a.png?ref=feature"),
			params(["docs", "a.png"]),
		);
		expect(repo.git.getFileContent).toHaveBeenCalledWith(
			repo.ref,
			"docs/a.png",
			"feature",
		);

		await GET(request(), params(["logo.png"]));
		expect(repo.git.getFileContent).toHaveBeenLastCalledWith(
			repo.ref,
			"logo.png",
			"main",
		);
	});
});
