// scripts/upload_recipe_photos.mjs: the checks that run before anything is uploaded, and --exclude.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verify, readRecord, isExcluded } from "../scripts/upload_recipe_photos.mjs";

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
