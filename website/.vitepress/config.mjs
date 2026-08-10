import { defineConfig } from "vitepress";

const SITE_URL = "https://manddarinshop.github.io/Hikoutei";

/**
 * Per-page canonical URL and og:url.
 *
 * VitePress serves clean URLs (`/guide/quick-start`), so the canonical href is
 * derived from the markdown relative path; the index page maps to the root.
 */
function pageUrl(relativePath) {
  const path = relativePath.replace(/\.md$/, "");
  return path === "index" ? `${SITE_URL}/` : `${SITE_URL}/${path}`;
}

/** Site-wide description fallback for pages without their own frontmatter. */
const SITE_DESCRIPTION =
  "Typed repository and safe write layer for Google Sheets-backed MVPs. SQLite-authoritative entity lifecycle with asynchronous Google Sheets projection.";

/**
 * Per-page description: the page's frontmatter description, else the site
 * description. VitePress does not derive a unique description from body text,
 * so a shared fallback keeps every page honest without inventing copy.
 */
function pageDescription(pageData) {
  const fromFrontmatter = pageData.frontmatter?.description;
  if (typeof fromFrontmatter === "string" && fromFrontmatter.trim() !== "") {
    return fromFrontmatter;
  }
  return SITE_DESCRIPTION;
}

export default defineConfig({
  title: "Hikoutei",
  description: SITE_DESCRIPTION,
  lang: "en-US",
  base: "/Hikoutei/",
  cleanUrls: true,
  head: [
    // og:title and og:description are emitted per page in `transformHead` so
    // each route gets its own metadata; the static list keeps only the
    // site-level tags and structured data.
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Hikoutei" }],
    ["meta", { name: "twitter:card", content: "summary" }],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareSourceCode",
        name: "Hikoutei",
        description:
          "Typed repository and safe write layer for Google Sheets-backed MVPs. SQLite is the application authority; Google Sheets is an asynchronous human-facing projection and input surface.",
        url: `${SITE_URL}/`,
        codeRepository: "https://github.com/ManddarinShop/Hikoutei",
        programmingLanguage: "TypeScript",
        license: "https://opensource.org/licenses/MIT",
        isAccessibleForFree: true,
      }),
    ],
  ],
  transformHead: ({ pageData }) => {
    const url = pageUrl(pageData.relativePath);
    // Page-specific title/description from frontmatter (or the site defaults),
    // so every route has distinct OG metadata instead of one shared block.
    // `pageData.title` can be an empty string (e.g. the home layout), so the
    // fallback treats empty titles as missing.
    const title = pageData.frontmatter?.title || pageData.title || "Hikoutei";
    const description = pageDescription(pageData);
    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/quick-start" },
      { text: "Templates", link: "/templates/sheet-approval" },
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
          {
            text: "Google Spreadsheet vs Hikoutei",
            link: "/guide/google-spreadsheet-vs-hikoutei",
          },
          {
            text: "Google Sheets as an ops UI",
            link: "/guide/google-sheets-as-ops-ui",
          },
          { text: "Benchmarks", link: "/guide/benchmarks" },
          { text: "Limitations", link: "/guide/limitations" },
          { text: "Project status", link: "/guide/status" },
        ],
      },
      {
        text: "Templates",
        items: [
          {
            text: "Sheet approval",
            link: "/templates/sheet-approval",
          },
          {
            text: "MCP human review",
            link: "/templates/mcp-human-review",
          },
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
