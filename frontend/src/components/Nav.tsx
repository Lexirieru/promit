"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Menu, X, Zap } from "lucide-react";

// `href` is optional: only Gallery has a destination so far (U5); the rest
// stay inert buttons until their surfaces exist.
const NAV_LINKS: { label: string; hasDropdown: boolean; href?: string }[] = [
  { label: "Gallery", hasDropdown: false, href: "/prompts" },
  { label: "For Agents", hasDropdown: true },
  { label: "For Creators", hasDropdown: false },
  { label: "Docs", hasDropdown: false },
];

export default function Nav() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <nav
        className="animate-fade-in-up relative z-20 mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6"
        style={{ animationDelay: "0.1s", opacity: 0 }}
      >
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 fill-black" />
          <span className="text-lg font-semibold">Promit</span>
        </div>

        <div className="hidden gap-8 md:flex">
          {NAV_LINKS.map(({ label, hasDropdown, href }) =>
            href ? (
              <Link
                key={label}
                href={href}
                className="flex items-center gap-1 text-sm text-gray-700 transition-colors hover:text-black"
              >
                {label}
              </Link>
            ) : (
              <button
                key={label}
                type="button"
                className="flex items-center gap-1 text-sm text-gray-700 transition-colors hover:text-black"
              >
                {label}
                {hasDropdown && <ChevronDown className="h-4 w-4" />}
              </button>
            ),
          )}
        </div>

        <div className="hidden items-center gap-4 sm:flex">
          <button
            type="button"
            className="text-sm text-gray-700 transition-colors hover:text-black"
          >
            Log in
          </button>
          <button
            type="button"
            className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
          >
            Start selling
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
            {NAV_LINKS.map(({ label, hasDropdown, href }) =>
              href ? (
                <Link
                  key={label}
                  href={href}
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-1 text-left text-sm text-gray-700 transition-colors hover:text-black"
                >
                  {label}
                </Link>
              ) : (
                <button
                  key={label}
                  type="button"
                  className="flex items-center gap-1 text-left text-sm text-gray-700 transition-colors hover:text-black"
                >
                  {label}
                  {hasDropdown && <ChevronDown className="h-4 w-4" />}
                </button>
              ),
            )}
            <div className="flex flex-col gap-4 border-t border-gray-200 pt-4">
              <button
                type="button"
                className="text-left text-sm text-gray-700 transition-colors hover:text-black"
              >
                Log in
              </button>
              <button
                type="button"
                className="w-full rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
              >
                Start selling
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
