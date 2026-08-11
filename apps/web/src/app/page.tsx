import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { safeRedirect } from "@/lib/utils";
import { HalftoneBackground } from "@/components/ui/halftone-background";
import { LoginButton } from "@/components/login-button";
import { DemoVideoDialog } from "@/components/demo-video";

export default async function HomePage({
	searchParams,
}: {
	searchParams: Promise<{ redirect?: string }>;
}) {
	const session = await getServerSession();
	const { redirect: redirectTo } = await searchParams;
	const safeTarget = safeRedirect(redirectTo);

	if (session) {
		redirect(safeTarget);
	}

	return (
		<div
			className="relative min-h-screen bg-background overflow-x-hidden"
			style={
				{
					"--background": "#030304",
					"--foreground": "#fafafa",
					"--shader-bg": "#09090b",
					"--shader-filter": "none",
					"--hero-border": "#27272a",
					"--border": "#27272a",
					colorScheme: "dark",
				} as React.CSSProperties
			}
		>
			{/* Shader — full screen */}
			<div
				className="absolute inset-0 overflow-hidden"
				style={{ background: "var(--shader-bg)" }}
			>
				<HalftoneBackground />

				{/* Bottom fade */}
				<div
					className="absolute inset-x-0 bottom-0 h-1/3 pointer-events-none z-10"
					style={{
						background: "linear-gradient(to top, var(--background) 0%, transparent 100%)",
					}}
				/>
			</div>

			<style>{`
				html, body { background: #030304; }
				@keyframes heroFadeUp {
					from { opacity: 0; transform: translateY(12px); filter: blur(4px); }
					to { opacity: 1; transform: translateY(0); filter: blur(0px); }
				}
				.hero-in {
					opacity: 0;
					animation: heroFadeUp 0.6s ease-out forwards;
				}
			`}</style>

			{/* Logo — top left */}
			<div
				className="hero-in absolute top-6 left-2 sm:left-4 z-30 flex items-center gap-1"
				style={{ animationDelay: "0.2s" }}
			>
				<svg
					className="size-5"
					viewBox="0 0 64 64"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<g fill="none" strokeWidth="6" strokeLinecap="round">
						<path d="M32 13V51" stroke="currentColor" />
						<circle cx="32" cy="32" r="11" stroke="#7C5CFF" />
					</g>
				</svg>
				<span className="text-sm tracking-tight text-foreground">
					ORKD.
				</span>
			</div>

			{/* Content */}
			<div className="relative z-20 min-h-screen flex items-center justify-center px-4 py-20">
				<div className="w-full max-w-md text-center">
					{/* Heading */}
					<h1
						className="hero-in text-3xl sm:text-4xl lg:text-5xl font-medium tracking-tight text-foreground leading-[1.1] mb-2"
						style={{ animationDelay: "0.4s" }}
					>
						Re-imagining{" "}
						<span className="text-white/80 font-mono">
							code
						</span>
						<br />
						collaboration.
					</h1>

					<p
						className="hero-in text-foreground/50 text-sm leading-relaxed mt-4 max-w-sm mx-auto"
						style={{ animationDelay: "0.6s" }}
					>
						A better place to collaborate on code — for humans
						and agents
					</p>

					{/* Watch demo */}
					<div
						className="hero-in mt-5 flex justify-center"
						style={{ animationDelay: "0.7s" }}
					>
						<DemoVideoDialog />
					</div>

					{/* Divider */}
					<div
						className="hero-in my-8 h-px"
						style={{
							animationDelay: "0.8s",
							background: "var(--hero-border)",
						}}
					/>

					{/* Login */}
					<div className="hero-in" style={{ animationDelay: "1.0s" }}>
						<LoginButton redirectTo={safeTarget} />
					</div>

					<p
						className="hero-in text-[11px] text-foreground/40 mt-3 mx-auto max-w-xs"
						style={{ animationDelay: "1.2s" }}
					>
						Your access token is encrypted and stored securely.
						Only the permissions you grant will be used.
					</p>

					<p
						className="hero-in text-[11px] text-foreground/30 mt-6"
						style={{ animationDelay: "1.3s" }}
					>
						Based on{" "}
						<a
							href="https://github.com/better-auth/better-hub"
							className="underline underline-offset-2 hover:text-foreground/60"
						>
							Better Hub
						</a>
						.
					</p>
				</div>
			</div>
		</div>
	);
}
