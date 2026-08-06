const SURFACES = ["Browser", "CLI", "MCP", "Claude Code"];

export default function Footer() {
  return (
    <footer
      className="animate-fade-in-up absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 px-4 pb-4 sm:gap-4 sm:pb-8"
      style={{ animationDelay: "0.6s", opacity: 0 }}
    >
      <span className="rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium text-white backdrop-blur-md sm:px-3.5 sm:text-xs">
        One catalog, purchasable from every surface an agent lives on
      </span>

      <div className="flex flex-wrap justify-center gap-5 sm:gap-12 md:gap-16">
        {SURFACES.map((name) => (
          <span
            key={name}
            className="text-lg text-white italic tracking-tight sm:text-2xl md:text-3xl"
            style={{ fontFamily: "Georgia, serif" }}
          >
            {name}
          </span>
        ))}
      </div>
    </footer>
  );
}
