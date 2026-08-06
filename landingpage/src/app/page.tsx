"use client";

import { useState } from "react";
import { ChevronDown, Menu, Star, X } from "lucide-react";

const VIDEO_SRC =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260330_153826_e9005cf7-a1c7-4c7d-886f-fea22d644a9c.mp4";

const NAV_LINKS = [
  { label: "Solutions", hasDropdown: true },
  { label: "For Teams", hasDropdown: true },
  { label: "About Us", hasDropdown: false },
  { label: "Learn Hub", hasDropdown: false },
];

const PARTNERS = ["Aeon", "Vela", "Apex", "Orbit", "Zeno"];

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-white">
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

      <nav
        className="animate-fade-in-up relative z-20 mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6"
        style={{ animationDelay: "0.1s", opacity: 0 }}
      >
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 fill-black" />
          <span className="text-lg font-semibold">Stellar.ai</span>
        </div>

        <div className="hidden gap-8 md:flex">
          {NAV_LINKS.map(({ label, hasDropdown }) => (
            <button
              key={label}
              type="button"
              className="flex items-center gap-1 text-sm text-gray-700 transition-colors hover:text-black"
            >
              {label}
              {hasDropdown && <ChevronDown className="h-4 w-4" />}
            </button>
          ))}
        </div>

        <div className="hidden items-center gap-4 sm:flex">
          <button
            type="button"
            className="text-sm text-gray-700 transition-colors hover:text-black"
          >
            Login
          </button>
          <button
            type="button"
            className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
          >
            Get started free
          </button>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          className="sm:hidden"
        >
          {menuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </nav>

      {menuOpen && (
        <div className="animate-fade-in-overlay absolute inset-x-0 top-[60px] z-30 border-b border-gray-200 bg-white/95 backdrop-blur-md">
          <div className="flex flex-col gap-4 px-6 py-4">
            {NAV_LINKS.map(({ label, hasDropdown }) => (
              <button
                key={label}
                type="button"
                className="flex items-center gap-1 text-left text-sm text-gray-700 transition-colors hover:text-black"
              >
                {label}
                {hasDropdown && <ChevronDown className="h-4 w-4" />}
              </button>
            ))}
            <div className="flex flex-col gap-4 border-t border-gray-200 pt-4">
              <button
                type="button"
                className="text-left text-sm text-gray-700 transition-colors hover:text-black"
              >
                Login
              </button>
              <button
                type="button"
                className="w-full rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
              >
                Get started free
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="relative z-20 mx-auto max-w-7xl px-4 pt-6 pb-16 text-center sm:px-6 sm:pt-12 sm:pb-32">
        <div
          className="animate-fade-in-up mb-5 inline-flex items-center gap-2 sm:mb-8"
          style={{ animationDelay: "0.2s", opacity: 0 }}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded border border-gray-300">
            <Star className="h-4 w-4 fill-black" />
          </span>
          <span className="text-xs font-medium text-black sm:text-sm">
            4.9 rating from 18.3K+ users
          </span>
        </div>

        <h1
          className="animate-fade-in-up mb-4 text-[38px] leading-[1.1] font-normal tracking-tight sm:mb-5 sm:text-6xl md:text-7xl lg:text-[80px]"
          style={{ animationDelay: "0.3s", opacity: 0 }}
        >
          <span className="sm:hidden">
            Work Smarter.
            <br />
            Move Faster.
            <br />
            <span className="bg-gradient-to-r from-black via-gray-500 to-gray-400 bg-clip-text text-transparent">
              AI Powers You Up.
            </span>
          </span>
          <span className="hidden sm:inline">
            Work Smarter. Move Faster.
            <br />
            <span className="bg-gradient-to-r from-black via-gray-500 to-gray-400 bg-clip-text text-transparent">
              AI Powers You Up.
            </span>
          </span>
        </h1>

        <p
          className="animate-fade-in-up mx-auto mb-6 max-w-2xl px-2 text-base text-gray-600 sm:mb-8 sm:text-lg md:text-xl"
          style={{ animationDelay: "0.4s", opacity: 0 }}
        >
          Intelligent automation syncs with the tools you love to streamline tasks, boost
          output, and save time.
        </p>

        <button
          type="button"
          className="animate-fade-in-up rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800 sm:px-8 sm:text-base"
          style={{ animationDelay: "0.5s", opacity: 0 }}
        >
          Begin Free Trial
        </button>
      </main>

      <div
        className="animate-fade-in-up absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-4 pb-4 sm:gap-4 sm:pb-8"
        style={{ animationDelay: "0.6s", opacity: 0 }}
      >
        <span className="rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium text-white backdrop-blur-md sm:px-3.5 sm:text-xs">
          Collaborating with top aerospace pioneers globally
        </span>

        <div className="flex flex-wrap justify-center gap-5 sm:gap-12 md:gap-16">
          {PARTNERS.map((name) => (
            <span
              key={name}
              className="text-lg text-white italic tracking-tight sm:text-2xl md:text-3xl"
              style={{ fontFamily: "Georgia, serif" }}
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
