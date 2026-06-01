const FEATURES = [
  {
    title: "Powerful models",
    description:
      "Access state-of-the-art AI models through one clean, consistent API.",
  },
  {
    title: "Built to scale",
    description:
      "From prototype to production — autoscaling infrastructure handles the load.",
  },
  {
    title: "Secure by design",
    description:
      "Encryption in transit and at rest, with role-based access for your team.",
  },
  {
    title: "Real-time analytics",
    description:
      "Track usage, latency, and cost with dashboards that update as you go.",
  },
  {
    title: "Ship in minutes",
    description:
      "Drop-in SDKs and copy-paste snippets take you from idea to live fast.",
  },
  {
    title: "Always-on support",
    description:
      "Documentation, guides, and a responsive team whenever you need a hand.",
  },
];

export function Features() {
  return (
    <section
      id="features"
      className="mx-auto max-w-6xl scroll-mt-16 px-6 py-24"
    >
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold text-slate-900 sm:text-4xl dark:text-white">
          Everything you need to build
        </h2>
        <p className="mt-4 text-slate-600 dark:text-slate-300">
          A complete toolkit for taking AI features from idea to production.
        </p>
      </div>

      <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-900/[0.03] transition hover:border-brand-300 hover:shadow-md dark:border-white/5 dark:bg-ink-800 dark:shadow-none dark:hover:border-brand-500/40"
          >
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand-100 ring-1 ring-brand-200 dark:bg-brand-600/15 dark:ring-0">
              <span className="h-2.5 w-2.5 rounded-sm bg-brand-500 dark:bg-brand-400" />
            </div>
            <h3 className="mt-5 text-lg font-semibold text-slate-900 dark:text-white">
              {f.title}
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              {f.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
