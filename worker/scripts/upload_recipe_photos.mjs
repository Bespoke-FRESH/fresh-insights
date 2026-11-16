#!/usr/bin/env node
// Upload catalog recipe photos to R2 for GET /recipe-photos/<sha256>.webp (fresh_app plan row P8).
//
//   node scripts/upload_recipe_photos.mjs [--dir <folder> --record <files_sha256.tsv>]
//                                         [--added <photo_added.json> --added-dir <folder>] [options]
//
// Two inputs; give either or both (both: one run, one plan, one count).
//
// 1. --dir + --record: a folder of .webp and a TSV with the header `file  sha256  bytes  px`, one row
//    per file in the folder. Every row is checked: the file exists, its size is `bytes`, its sha256
//    is `sha256` (64 lowercase hex), and every .webp in the folder has a row.
// 2. --added + --added-dir: a fresh_composition `photo_added.json` (`photos[]`, each with `file` and
//    `webp_sha256`) and the folder its release's `recipe_img.zip` was extracted to. Each listed file
//    is looked for recursively under the folder (it must be found exactly once) and its sha256 must
//    be `webp_sha256`. A file the record does not list is ignored: the zip holds other recipes' photos.
//
// All checks run before any network call; any problem stops the run with nothing uploaded. Each
// file then goes to the bucket under the key `<sha256>.webp` with content type image/webp; a key
// that already exists is skipped.
//
// DRY RUN BY DEFAULT: without --write nothing is written anywhere; it prints what it would upload.
//
// Options:
//   --write               actually upload (wrangler r2 object put --remote). Without it: dry run.
//   --exclude <name>      leave a file out; repeatable or comma-separated. <name> is the file name
//                         (usda_pear-rabbit__higgsfield.webp), the name without .webp, or the recipe
//                         id before any `__` suffix (usda_pear-rabbit).
//   --bucket <name>       R2 bucket (default fresh-recipe-photos, the RECIPE_PHOTOS binding).
//   --base <url>          the Worker whose HEAD /recipe-photos/<sha256>.webp tells whether a key
//                         exists (default https://fresh-insights-engage.freshfoodrecs.workers.dev).
//   --offline             skip the existence check (every key counts as missing). Dry run only.
//
// Existence is read through the Worker's own public route, so the check needs no Cloudflare
// credentials: 200 = exists (skip), 404 = missing (upload), anything else stops the run. Writes
// go through wrangler, run from this worker/ folder, so they use wrangler's own login.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUCKET = "fresh-recipe-photos";
const DEFAULT_BASE = "https://fresh-insights-engage.freshfoodrecs.workers.dev";
const HASH = /^[0-9a-f]{64}$/;

function die(msg) {
  console.error(`upload_recipe_photos: ${msg}`);
  process.exit(1);
}

export function parseArgs(argv) {
  const opts = { write: false, offline: false, exclude: [], bucket: DEFAULT_BUCKET, base: DEFAULT_BASE, dir: null, record: null, added: null, addedDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) die(`${a} needs a value`);
      return v;
    };
    if (a === "--write") opts.write = true;
    else if (a === "--offline") opts.offline = true;
    else if (a === "--dir") opts.dir = val();
    else if (a === "--record") opts.record = val();
    else if (a === "--added") opts.added = val();
    else if (a === "--added-dir") opts.addedDir = val();
    else if (a === "--bucket") opts.bucket = val();
    else if (a === "--base") opts.base = val().replace(/\/+$/, "");
    else if (a === "--exclude") opts.exclude.push(...val().split(",").map((s) => s.trim()).filter(Boolean));
    else die(`unknown argument ${a}`);
  }
  if (!!opts.dir !== !!opts.record) die("--dir and --record go together");
  if (!!opts.added !== !!opts.addedDir) die("--added and --added-dir go together");
  if (!opts.dir && !opts.added) die("give --dir + --record, --added + --added-dir, or both");
  if (opts.write && opts.offline) die("--offline is for a dry run only; a write checks what exists first");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(opts.bucket)) die(`not a bucket name: ${opts.bucket}`);
  return opts;
}

export function isExcluded(file, exclude) {
  const stem = file.replace(/\.webp$/, "");
  const recipe = stem.split("__")[0];
  return exclude.some((x) => x === file || x === stem || x.replace(/\.webp$/, "") === recipe);
}

export function readRecord(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = (lines.shift() || "").split("\t").map((s) => s.trim());
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) die(`record has no "${name}" column (header: ${header.join(", ")})`);
    return i;
  };
  const [iFile, iHash, iBytes, iPx] = [col("file"), col("sha256"), col("bytes"), col("px")];
  return lines.map((l, n) => {
    const f = l.split("\t");
    return { line: n + 2, file: f[iFile], sha256: f[iHash], bytes: Number(f[iBytes]), px: f[iPx] };
  });
}

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const goodName = (f) => typeof f === "string" && f !== "" && basename(f) === f && f.endsWith(".webp");

// Every check on the TSV input, before any network call. Returns the problems found; empty means
// all good. Each good row gains `path`.
export function verify(dir, rows) {
  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    if (!goodName(r.file)) { problems.push(`line ${r.line}: bad file name ${JSON.stringify(r.file)}`); continue; }
    if (seen.has(r.file)) problems.push(`line ${r.line}: ${r.file} listed twice`);
    seen.add(r.file);
    if (!HASH.test(r.sha256 || "")) { problems.push(`line ${r.line}: ${r.file}: sha256 is not 64 lowercase hex`); continue; }
    r.path = join(dir, r.file);
    let bytes;
    try { bytes = readFileSync(r.path); } catch { problems.push(`${r.file}: listed but not in the folder`); continue; }
    if (!Number.isInteger(r.bytes) || bytes.length !== r.bytes) problems.push(`${r.file}: ${bytes.length} bytes, record says ${r.bytes}`);
    const actual = sha256Of(bytes);
    if (actual !== r.sha256) problems.push(`${r.file}: sha256 ${actual}, record says ${r.sha256}`);
  }
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".webp") && statSync(join(dir, f)).isFile() && !seen.has(f)) problems.push(`${f}: in the folder but not in the record`);
  }
  return problems;
}

// Every .webp under `dir`, recursively, by file name -> its paths.
function indexTree(dir) {
  const byName = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".webp")) byName.set(e.name, [...(byName.get(e.name) || []), p]);
    }
  };
  walk(dir);
  return byName;
}

// The photo_added.json input: parse, find each listed file under `dir` (recursively, exactly once),
// and check its sha256 against `webp_sha256`. Files the record does not list are never read.
// Returns { rows, problems }; rows carry file, sha256, bytes, path.
export function verifyAdded(dir, json) {
  const problems = [];
  const rows = [];
  let doc;
  try { doc = JSON.parse(json); } catch { return { rows, problems: ["photo_added record is not JSON"] }; }
  if (!doc || !Array.isArray(doc.photos)) return { rows, problems: ["photo_added record has no photos[]"] };
  const tree = indexTree(dir);
  const seen = new Set();
  doc.photos.forEach((p, i) => {
    const at = `photos[${i}]`;
    const file = p && p.file;
    if (!goodName(file)) { problems.push(`${at}: bad file name ${JSON.stringify(file)}`); return; }
    if (seen.has(file)) problems.push(`${at}: ${file} listed twice`);
    seen.add(file);
    if (!HASH.test(p.webp_sha256 || "")) { problems.push(`${at}: ${file}: webp_sha256 is not 64 lowercase hex`); return; }
    const paths = tree.get(file) || [];
    if (paths.length === 0) { problems.push(`${file}: listed but not under the folder`); return; }
    if (paths.length > 1) { problems.push(`${file}: found ${paths.length} times under the folder`); return; }
    const bytes = readFileSync(paths[0]);
    const actual = sha256Of(bytes);
    if (actual !== p.webp_sha256) { problems.push(`${file}: sha256 ${actual}, record says ${p.webp_sha256}`); return; }
    rows.push({ file, sha256: p.webp_sha256, bytes: bytes.length, path: paths[0] });
  });
  return { rows, problems };
}

async function exists(base, key) {
  const res = await fetch(`${base}/recipe-photos/${key}`, { method: "HEAD", redirect: "manual" });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  die(`HEAD ${base}/recipe-photos/${key} answered ${res.status}; cannot tell whether it exists, stopping`);
}

function put(bucket, key, path) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["wrangler", "r2", "object", "put", `${bucket}/${key}`, `--file=${path}`, "--content-type=image/webp", "--remote"];
  // npx.cmd needs a shell on Windows; quote each argument so a path with spaces stays one argument.
  const shell = process.platform === "win32";
  const r = spawnSync(npx, shell ? args.map((a) => `"${a}"`) : args, { cwd: WORKER_DIR, stdio: "inherit", shell });
  if (r.status !== 0) die(`wrangler put ${key} failed (exit ${r.status}); earlier uploads stand, rerun to continue (existing keys are skipped)`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = [];
  const problems = [];

  if (opts.dir) {
    const tsvRows = readRecord(readFileSync(resolve(opts.record), "utf8"));
    const p = verify(resolve(opts.dir), tsvRows);
    problems.push(...p);
    if (!p.length) { console.log(`verified ${tsvRows.length} files against ${basename(opts.record)} (size and sha256)`); rows.push(...tsvRows); }
  }
  if (opts.added) {
    const { rows: addedRows, problems: p } = verifyAdded(resolve(opts.addedDir), readFileSync(resolve(opts.added), "utf8"));
    problems.push(...p);
    if (!p.length) { console.log(`verified ${addedRows.length} files against ${basename(opts.added)} (sha256)`); rows.push(...addedRows); }
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    die(`${problems.length} problem(s) in the folders or the records; nothing uploaded`);
  }

  const unmatched = opts.exclude.filter((x) => !rows.some((r) => isExcluded(r.file, [x])));
  if (unmatched.length) die(`--exclude matched no file: ${unmatched.join(", ")}`);
  const excluded = rows.filter((r) => isExcluded(r.file, opts.exclude));
  for (const r of excluded) console.log(`excluded  ${r.file}`);

  // One object per hash: two files with the same bytes are one upload.
  const byKey = new Map();
  for (const r of rows) if (!excluded.includes(r)) {
    const key = `${r.sha256}.webp`;
    if (byKey.has(key)) console.log(`same bytes  ${r.file} = ${byKey.get(key).file} (one object)`);
    else byKey.set(key, r);
  }

  const toUpload = [];
  let present = 0;
  for (const [key, r] of byKey) {
    if (!opts.offline && (await exists(opts.base, key))) { present++; console.log(`exists    ${key}  ${r.file}`); continue; }
    toUpload.push([key, r]);
  }

  const mode = opts.write ? "WRITE" : "DRY RUN";
  console.log(`\n${mode}: bucket ${opts.bucket}; ${byKey.size} objects, ${present} already present${opts.offline ? " (existence not checked: --offline)" : ""}, ${toUpload.length} to upload, ${excluded.length} excluded`);
  for (const [key, r] of toUpload) {
    console.log(`${opts.write ? "upload" : "would upload"}  ${opts.bucket}/${key}  ${r.file}  ${r.bytes} B  image/webp`);
    if (opts.write) put(opts.bucket, key, r.path);
  }
  if (!opts.write) console.log(`\nnothing written. Add --write to upload.`);
  else console.log(`\nuploaded ${toUpload.length}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
