import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { hostedRepo } from "@/lib/repos/hosted-source";
import { repositoryPermission } from "@/lib/repos/registry";

/**
 * Types safe to hand a browser as-is. Raster images render in an <img>, and
 * none of them can execute — svg and html deliberately have no entry, so a
 * repository cannot serve script from our origin.
 */
const RENDERABLE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
};

/**
 * The bytes of a file, unmodified.
 *
 * Repositories we host have no `raw.githubusercontent.com` to point a download
 * or an <img> at, and the JSON readers decode content as text — which a binary
 * cannot survive. This streams what the backend stored, so an image renders
 * and a download is the file rather than a mangled transcription of it.
 */
export async function GET(
	request: NextRequest,
	context: { params: Promise<{ owner: string; repo: string; path: string[] }> },
) {
	const { owner, repo, path } = await context.params;
	const filePath = path.map(decodeURIComponent).join("/");
	if (!filePath) {
		return NextResponse.json({ error: "Missing file path" }, { status: 400 });
	}

	const hosted = await hostedRepo(owner, repo);
	if (!hosted) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	// A private repository's bytes are as private as its pages.
	if (hosted.record.isPrivate) {
		const session = await getServerSession();
		const permission = await repositoryPermission(
			hosted.record,
			session?.user?.id ?? null,
		);
		if (!permission) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
	}

	const ref = request.nextUrl.searchParams.get("ref") || hosted.defaultBranch;
	const blob = await hosted.git.getFileContent(hosted.ref, filePath, ref);
	if (!blob) {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}

	const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
	return new NextResponse(new Uint8Array(blob.content), {
		headers: {
			"Content-Type": RENDERABLE_TYPES[extension] ?? "application/octet-stream",
			"Content-Length": String(blob.size),
			"Content-Disposition": `inline; filename="${encodeURIComponent(
				filePath.split("/").pop() ?? filePath,
			)}"`,
			"Cache-Control": hosted.record.isPrivate
				? "private, no-store"
				: "public, max-age=60",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
