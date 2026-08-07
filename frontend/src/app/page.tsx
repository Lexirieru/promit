import Link from "next/link";
import { Zap } from "lucide-react";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AgentOnboarding from "@/components/AgentOnboarding";

const VIDEO_SRC = "/media/hero.mp4";

export default function Home() {
  return (
    <div className="relative w-full bg-white">
      {/* The hero keeps its full-viewport stage; the clipping that used to
          live on the page root moved here so sections can exist below it. */}
      <section className="relative h-screen w-full overflow-hidden">
        <video
          className="absolute inset-0 h-full w-full object-cover pt-[120px] md:pt-[200px]"
          src={VIDEO_SRC}
          autoPlay
          loop
          muted
          playsInline
        />

        {/* White gradients dissolve the video into the clean upper section. */}
        <div
          className="pointer-events-none absolute inset-x-0 z-10 bg-gradient-to-b from-white to-transparent"
          style={{ top: 120, height: 200 }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 z-10 hidden bg-gradient-to-b from-white to-transparent md:block"
          style={{ top: 200, height: 300 }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 z-10 bg-gradient-to-b from-white to-transparent md:hidden"
          style={{ top: 120, height: 200 }}
        />

        <Nav />

        <main className="relative z-20 mx-auto max-w-7xl px-4 pt-6 pb-16 text-center sm:px-6 sm:pt-12 sm:pb-32">
          <div
            className="animate-fade-in-up mb-5 inline-flex items-center gap-2 sm:mb-8"
            style={{ animationDelay: "0.2s", opacity: 0 }}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded border border-gray-300">
              <Zap className="h-4 w-4 fill-black" />
            </span>
            <span className="text-xs font-medium text-black sm:text-sm">
              Priced in cents. Settled over x402.
            </span>
          </div>

          <h1
            className="animate-fade-in-up mb-4 text-[38px] leading-[1.1] font-normal tracking-tight sm:mb-5 sm:text-6xl md:text-7xl lg:text-[80px]"
            style={{ animationDelay: "0.3s", opacity: 0 }}
          >
            <span className="sm:hidden">
              Pay per prompt.
              <br />
              Not per month.
              <br />
              <span className="bg-gradient-to-r from-black via-gray-500 to-gray-400 bg-clip-text text-transparent">
                Unlock with cents of USDC.
              </span>
            </span>
            <span className="hidden sm:inline">
              Pay per prompt. Not per month.
              <br />
              <span className="bg-gradient-to-r from-black via-gray-500 to-gray-400 bg-clip-text text-transparent">
                Unlock with cents of USDC.
              </span>
            </span>
          </h1>

          <p
            className="animate-fade-in-up mx-auto mb-6 max-w-2xl px-2 text-base text-gray-600 sm:mb-8 sm:text-lg md:text-xl"
            style={{ animationDelay: "0.4s", opacity: 0 }}
          >
            Prom It is a prompt marketplace where one x402 request buys one
            prompt — for humans in the browser and autonomous agents on the
            CLI, MCP, and Claude Code.
          </p>

          <Link
            href="/prompts"
            className="animate-fade-in-up inline-block rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 sm:px-8 sm:text-base"
            style={{ animationDelay: "0.5s", opacity: 0 }}
          >
            Explore the gallery
          </Link>
        </main>

        <Footer />
      </section>

      <AgentOnboarding />
    </div>
  );
}
