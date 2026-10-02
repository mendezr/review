import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { updateLockfileContent } from "../scripts/update-requirements-ci-hashes.mjs";

// Opt in to the real uv/PyPI regression; unit tests need neither tool nor network.
test("real uv prunes obsolete pins instead of treating them as dependencies", {
	skip: !process.env.CI_LOCK_UV_TEST,
}, async () => {
	const source = await readFile("requirements-ci.lock", "utf8");
	// An obsolete pin must not even need a published version to resolve.
	const updated = await updateLockfileContent(`${source}\nunused-ci-dependency==999.0.0\n    # via pre-commit\nunannotated-ci-dependency==999.0.0\n`);
	assert.doesNotMatch(updated, /unused-ci-dependency|unannotated-ci-dependency/);
	assert.equal(updated.match(/^pre-commit==[^\s]+/m)?.[0], source.match(/^pre-commit==[^\s]+/m)?.[0]);
	assert.match(updated, /^virtualenv==/m);
	assert.match(updated, /--hash=sha256:[0-9a-f]{64}/);
	assert.equal(await updateLockfileContent(updated), updated);
	// A needed package must still obey its Renovate pin, not silently upgrade.
	await assert.rejects(
		() => updateLockfileContent(source.replace(/^cfgv==[^\s]+/m, "cfgv==999.0.0")),
		/dependency resolution failed/,
	);
});
