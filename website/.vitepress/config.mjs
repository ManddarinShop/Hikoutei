import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Hikoutei",
  description:
    "Typed repository and safe write layer for Google Sheets-backed MVPs. SQLite-authoritative entity lifecycle with asynchronous Google Sheets projection.",
  lang: "en-US",
  base: "/Hikoutei/",
  cleanUrls: true,
  head: [
    ["meta", { property: "og:title", content: "Hikoutei" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Typed repository and safe write layer for Google Sheets-backed MVPs. Keep your app fast with SQLite, keep your workflow visible in Google Sheets.",
      },
    ],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    [
      "link",
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    ],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;650;700;800&display=swap",
      },
    ],
    [
      "link",
      {
        rel: "icon",
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%231a88f8'/%3E%3Ctext x='50' y='68' font-size='52' text-anchor='middle' fill='white' font-family='Inter,sans-serif' font-weight='700'%3EH%3C/text%3E%3C/svg%3E",
      },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/quick-start" },
      { text: "Benchmarks", link: "/guide/benchmarks" },
      {
        text: "GitHub",
        link: "https://github.com/ManddarinShop/Hikoutei",
      },
      {
        text: "npm",
        link: "https://www.npmjs.com/package/hikoutei",
      },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Hikoutei", link: "/guide/what-is-hikoutei" },
          { text: "Quick start", link: "/guide/quick-start" },
          { text: "Google Sheets setup", link: "/guide/setup" },
          { text: "Architecture", link: "/guide/architecture" },
          { text: "Write and synchronization flow", link: "/guide/sync-flow" },
          {
            text: "Internal consistency model",
            link: "/guide/internal-consistency",
          },
          { text: "Benchmarks", link: "/guide/benchmarks" },
          { text: "Limitations", link: "/guide/limitations" },
          { text: "Project status", link: "/guide/status" },
        ],
      },
      {
        text: "Repository",
        items: [
          { text: "Contributing", link: "/guide/contributing" },
          { text: "Release process", link: "/guide/release-process" },
        ],
      },
    ],
    footer: {
      message: "MIT Licensed",
    },
  },
});
