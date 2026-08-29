#!/usr/bin/env node
// Marker census for the 0.9 cleanup baseline: case-insensitive word-boundary
// count of TODO/FIXME/HACK/XXX/LEGACY/DEPRECATED across src/**/*.ts.
// Read-only audit; prints totals per marker, top files, and file:line entries.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src"];
const MARKERS = ["todo", "fixme", "hack", "xxx", "legacy", "deprecated"];
const PATTERN = new RegExp(`\\b(${MARKERS.join("|")})\\b`, "gi");

/** @returns {string[]} */
function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** @type {{file: string, line: number, marker: string, excerpt: string}[]} */
const hits = [];
for (const root of ROOTS) {
  for (const file of listTsFiles(root)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const matches = lines[i].match(PATTERN);
      if (matches === null) continue;
      for (const raw of matches) {
        hits.push({
          file: relative('.', file),
          line: i + 1,
          marker: raw.toLowerCase(),
          excerpt: lines[i].trim().slice(0, 120),
        });
      }
    }
  }
}

const perMarker = {};
for (const marker of MARKERS) perMarker[marker] = 0;
for (const hit of hits) perMarker[hit.marker] += 1;

const perFile = new Map();
for (const hit of hits) {
  perFile.set(hit.file, (perFile.get(hit.file) ?? 0) + 1);
}
const topFiles = [...perFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const markers = {
  hit: hits.length,
  marker: perMarker,
}

console.log(`TOTAL HITS: ${hits.length}`);
console.log("\n## per-marker totals");
for (const marker of MARKERS) console.log(`${marker}: ${perMarker[marker]}`);
console.log("\n## top 30 entries");
for (const hit of hits.slice(0, 30)) {
  console.log(`${hit.file}:${hit.line} [${hit.marker}] ${hit.excerpt}`);
}
if (hits.length > 30) console.log(`... and ${hits.length - 30} more`);
console.log("\n## all files with counts");
for (const [file, count] of topFiles) console.log(`${count}\t${file}`);