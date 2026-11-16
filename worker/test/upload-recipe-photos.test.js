// scripts/upload_recipe_photos.mjs: the checks that run before anything is uploaded, and --exclude.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verify, verifyAdded, readRecord, isExcluded } from "../scripts/upload_recipe_photos.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/upload_recipe_photos.mjs", import.meta.url));

const sha = (b) => createHash("sha256").update(b).digest("hex");
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rp-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(files) {
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
}
const tsv = (rows) => ["file\tsha256\tbytes\tpx", ...rows.map((r) => r.join("\t"))].join("\r\n") + "\r\n";

describe("upload_recipe_photos verify", () => {
  it("passes a folder that matches its record", () => {
    const a = Buffer.from("aaaa"), b = Buffer.from("bbbbbb");
    setup({ "gen_a.webp": a, "usda_b__x.webp": b });
    const rows = readRecord(tsv([["gen_a.webp", sha(a), a.length, 1024], ["usda_b__x.webp", sha(b), b.length, 480]]));
    expect(rows).toHaveLength(2);
    expect(verify(dir, rows)).toEqual([]);
  });

  it("reports a wrong hash, a wrong size, a missing file and an unrecorded file", () => {
    const a = Buffer.from("aaaa"), b = Buffer.from("bbbb");
    setup({ "a.webp": a, "b.webp": b, "extra.webp": Buffer.from("e") });
    const rows = readRecord(tsv([
      ["a.webp", sha(Buffer.from("other")), a.length, 1024],
      ["b.webp", sha(b), 99, 1024],
      ["gone.webp", sha(b), 4, 1024],
    ]));
    const problems = verify(dir, rows).join("\n");
    expect(problems).toMatch(/a\.webp: sha256/);
    expect(problems).toMatch(/b\.webp: 4 bytes, record says 99/);
    expect(problems).toMatch(/gone\.webp: listed but not in the folder/);
    expect(problems).toMatch(/extra\.webp: in the folder but not in the record/);
  });

  it("refuses an uppercase or short hash and a path in the file column", () => {
    const a = Buffer.from("aaaa");
    setup({ "a.webp": a });
    const rows = readRecord(tsv([["a.webp", sha(a).toUpperCase(), 4, 1], ["../a.webp", sha(a), 4, 1]]));
    const problems = verify(dir, rows).join("\n");
    expect(problems).toMatch(/not 64 lowercase hex/);
    expect(problems).toMatch(/bad file name/);
  });
});

describe("upload_recipe_photos --exclude", () => {
  it("matches the file name, the name without .webp, or the recipe id before __", () => {
    const f = "usda_pear-rabbit__higgsfield.webp";
    for (const x of [f, "usda_pear-rabbit__higgsfield", "usda_pear-rabbit", "usda_pear-rabbit.webp"]) {
      expect(isExcluded(f, [x]), x).toBe(true);
    }
    expect(isExcluded(f, ["usda_pear"])).toBe(false);
    expect(isExcluded("usda_pear-rabbit-salad.webp", ["usda_pear-rabbit"])).toBe(false);
  });
});

describe("upload_recipe_photos --added (photo_added.json)", () => {
  const added = (photos) => JSON.stringify({ release: "recipes-test", photos });
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, "--offline"], { encoding: "utf8" });

  function tree() {
    // The zip's layout: listed photos in a subfolder, beside photos of other recipes.
    const good = Buffer.from("listed photo"), other = Buffer.from("another recipe's photo");
    mkdirSync(join(dir, "recipe_img", "gen"), { recursive: true });
    writeFileSync(join(dir, "recipe_img", "gen", "gen_pizza__gptimage26.webp"), good);
    writeFileSync(join(dir, "recipe_img", "usda_unlisted__gemini.webp"), other);
    return { good, other };
  }

  it("accepts a listed file whose sha256 matches, found recursively, and ignores an unlisted one", () => {
    const { good } = tree();
    const { rows, problems } = verifyAdded(dir, added([{ recipe_id: "gen:pizza", file: "gen_pizza__gptimage26.webp", webp_sha256: sha(good), webp_px: [800, 800] }]));
    expect(problems).toEqual([]);
    expect(rows).toEqual([{ file: "gen_pizza__gptimage26.webp", sha256: sha(good), bytes: good.length, path: join(dir, "recipe_img", "gen", "gen_pizza__gptimage26.webp") }]);
  });

  it("reports a mismatched sha256, a missing file and a bad hash", () => {
    tree();
    const { problems } = verifyAdded(dir, added([
      { file: "gen_pizza__gptimage26.webp", webp_sha256: sha(Buffer.from("not it")) },
      { file: "gen_gone.webp", webp_sha256: sha(Buffer.from("x")) },
      { file: "usda_unlisted__gemini.webp", webp_sha256: "ABC" },
    ]));
    const all = problems.join("\n");
    expect(all).toMatch(/gen_pizza__gptimage26\.webp: sha256 .* record says/);
    expect(all).toMatch(/gen_gone\.webp: listed but not under the folder/);
    expect(all).toMatch(/webp_sha256 is not 64 lowercase hex/);
  });

  it("end to end: a matching record plans one upload and leaves the unlisted file out", () => {
    const { good, other } = tree();
    const rec = join(dir, "photo_added.json");
    writeFileSync(rec, added([{ file: "gen_pizza__gptimage26.webp", webp_sha256: sha(good) }]));
    const r = run("--added", rec, "--added-dir", dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/verified 1 files against photo_added\.json/);
    expect(r.stdout).toMatch(/DRY RUN: .*1 objects, .*1 to upload/);
    expect(r.stdout).toContain(`${sha(good)}.webp`);
    expect(r.stdout).not.toContain("usda_unlisted");
    expect(r.stdout).not.toContain(sha(other));
    expect(r.stdout).toMatch(/nothing written/);
  });

  it("end to end: a mismatched sha256 stops the run with nothing planned", () => {
    tree();
    const rec = join(dir, "photo_added.json");
    writeFileSync(rec, added([{ file: "gen_pizza__gptimage26.webp", webp_sha256: sha(Buffer.from("wrong")) }]));
    const r = run("--added", rec, "--added-dir", dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/nothing uploaded/);
    expect(r.stdout).not.toMatch(/would upload/);
  });

  it("end to end: both inputs in one run are one plan", () => {
    const { good } = tree();
    const tsvDir = join(dir, "chosen");
    mkdirSync(tsvDir);
    const a = Buffer.from("catalog photo");
    writeFileSync(join(tsvDir, "gen_a.webp"), a);
    const tsvPath = join(dir, "files_sha256.tsv");
    writeFileSync(tsvPath, tsv([["gen_a.webp", sha(a), a.length, 1024]]));
    const rec = join(dir, "photo_added.json");
    writeFileSync(rec, added([{ file: "gen_pizza__gptimage26.webp", webp_sha256: sha(good) }]));
    const r = run("--dir", tsvDir, "--record", tsvPath, "--added", rec, "--added-dir", join(dir, "recipe_img"));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN: .*2 objects, .*2 to upload/);
  });
});
