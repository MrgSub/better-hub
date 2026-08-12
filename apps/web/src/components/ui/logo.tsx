import { cn } from "@/lib/utils";

/**
 * The Orkd mark: a commit node on a branch line, which also reads as the "o" in
 * orkd. The node keeps its violet in either theme; the line follows the text.
 */
export function LogoGlyph({ className }: { className?: string }) {
	return (
		<svg
			className={cn("size-4", className)}
			viewBox="0 0 64 64"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
		>
			<g fill="none" strokeWidth="6" strokeLinecap="round">
				<path d="M32 13V51" stroke="currentColor" />
				<circle cx="32" cy="32" r="11" stroke="#7C5CFF" />
			</g>
		</svg>
	);
}

export function Logo({ className }: { className?: string }) {
	return (
		<span className={cn("font-mono text-sm font-medium tracking-tight", className)}>
			ORKD.
		</span>
	);
}

export function LogoMark({ className }: { className?: string }) {
	return (
		<span className={cn("font-mono text-sm font-bold tracking-tight", className)}>
			o.
		</span>
	);
}
