"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Menu, X } from "lucide-react";

/**
 * Setiap item nav MENUNJUK ke permukaan yang benar-benar ada. Versi lama
 * membawa sisa template SaaS — "Log in" (Prom It tidak punya login;
 * identitas adalah wallet), "For Agents"/"Docs" sebagai tombol mati dengan
 * dropdown palsu, dan "Start selling" yang tidak menunjuk ke mana-mana.
 * Tombol yang tidak melakukan apa-apa adalah janji kosong; jangan
 * menambahkan item di sini sebelum halamannya ada.
 */
const NAV_LINKS: { label: string; href: string }[] = [
  { label: "Gallery", href: "/prompts" },
  { label: "For Creators", href: "/list" },
  { label: "Earnings", href: "/earnings" },
];

export default function Nav() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <nav
        className="animate-fade-in-up relative z-20 mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6"
        style={{ animationDelay: "0.1s", opacity: 0 }}
      >
        {/* Logo gelap di latar terang; kalau nav suatu saat pindah ke
            permukaan gelap, beri varian atau `invert` — jangan biarkan
            logo hitam di atas latar hitam. */}
        <Link href="/" className="flex items-center">
          <Image
            src="/promit-logo.png"
            alt="Prom It"
            width={64}
            height={64}
            className="h-12 w-12 sm:h-14 sm:w-14"
            priority
          />
        </Link>

        <div className="hidden gap-8 md:flex">
          {NAV_LINKS.map(({ label, href }) => (
            <Link
              key={label}
              href={href}
              className="flex items-center gap-1 text-sm text-gray-700 transition-colors hover:text-black"
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 sm:flex">
          <Link
            href="/list"
            className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800"
          >
            Start selling
          </Link>
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
            {NAV_LINKS.map(({ label, href }) => (
              <Link
                key={label}
                href={href}
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-1 text-left text-sm text-gray-700 transition-colors hover:text-black"
              >
                {label}
              </Link>
            ))}
            <div className="flex flex-col gap-4 border-t border-gray-200 pt-4">
              <Link
                href="/list"
                onClick={() => setMenuOpen(false)}
                className="w-full rounded-full bg-black px-5 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-gray-800"
              >
                Start selling
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
