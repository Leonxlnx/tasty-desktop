import assert from "node:assert/strict";
import test from "node:test";
import { assertReviewedHash, generatedTextDrift, licenseRootDrift, normalizedLockfileHash, parseCargoPackage, parseCargoTree } from "./check-third-party-licenses.mjs";

test("parses and deduplicates Cargo's Windows package graph", () => {
  assert.deepEqual(parseCargoTree("demo v1.0.0\ndep v2.0.0\ndep v2.0.0 (*)\n"), [
    { name: "demo", version: "1.0.0" },
    { name: "dep", version: "2.0.0" },
  ]);
});

test("reads only Cargo package license metadata", () => {
  assert.deepEqual(parseCargoPackage('[package]\nlicense = "MIT"\nlicense-file = "LICENSE"\nrepository = "https://example.test/repo"\n[dependencies]\nlicense = "ignored"\n'), {
    license: "MIT",
    licenseFile: "LICENSE",
    repository: "https://example.test/repo",
  });
});

test("pins reviewed evidence and identifies stale generated texts", () => {
  assert.equal(assertReviewedHash(Buffer.from("license"), "cc1d3b0234846714b0aeda6cc34b057b4305bb83dd447fb88f816efeb59a4e96", "fixture"), "cc1d3b0234846714b0aeda6cc34b057b4305bb83dd447fb88f816efeb59a4e96");
  assert.throws(() => assertReviewedHash(Buffer.from("changed"), "cc1d3b0234846714b0aeda6cc34b057b4305bb83dd447fb88f816efeb59a4e96", "fixture"), /changed/);
  assert.deepEqual(generatedTextDrift(["a.txt", "stale.txt"], ["a"]), { missing: [], extras: ["stale.txt"] });
});

test("allows only the three reviewed license-root entries", () => {
  assert.deepEqual(licenseRootDrift(["texts", "inventory.json", "upstream"]), { missing: [], extras: [] });
  assert.deepEqual(licenseRootDrift(["texts", "notes.txt"]), { missing: ["inventory.json", "upstream"], extras: ["notes.txt"] });
});

test("hashes lockfiles independently of checkout line endings", () => {
  assert.equal(normalizedLockfileHash("one\r\ntwo\r\n"), normalizedLockfileHash("one\ntwo\n"));
  assert.notEqual(normalizedLockfileHash("one\ntwo\n"), normalizedLockfileHash("one\nchanged\n"));
});
