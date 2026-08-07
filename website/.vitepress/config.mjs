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
