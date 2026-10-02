import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";
const REQUIREMENT_PATTERN =
	/^(?<name>[a-zA-Z0-9._-]+)(?<extras>\[[^\]\n]*\])?\s*==\s*(?<version>[0-9][a-zA-Z0-9._!*+-]*)(?<marker>\s*;.*)?$/;

export function parseRequirement(line) {
	const spec = line.replace(/\s*\\\s*$/, "").trim();
	const match = spec.match(REQUIREMENT_PATTERN);
	if (!match) return null;
	const { name, extras = "", version, marker = "" } = match.groups;
	return { name, version, spec: `${name}${extras}==${version}${marker}` };
}

export async function updateLockfileContent(source, runImpl = spawnSync) {
	const requirements = [];
	const header = [];
	for (const line of source.split("\n")) {
		if (!line.trim() || line.trim().startsWith("#")) {
			if (requirements.length === 0) header.push(line);
			continue;
		}
		if (/^\s+--hash=sha256:[0-9a-f]{64}(?:\s*\\)?\s*$/.test(line)) continue;
		const requirement = parseRequirement(line);
		if (!requirement) {
			throw new Error(`${LOCKFILE}: cannot parse requirement line: ${line.trim()}`);
		}
		requirements.push(requirement.spec);
	}
	if (requirements.length === 0) return source;

	// Resolve the complete closure, keeping Renovate's pins. Only sanitized
	// requirements cross the PR boundary: no config, indexes, or build hooks.
	const result = runImpl(
		"uv",
		[
			"--no-config", "pip", "compile", "-", "--generate-hashes",
			"--python-version", "3.13", "--only-binary", ":all:",
			// Annotations stay on: the lockfile already carries the `# via`
			// lines, and --no-annotate would rewrite every block of the file on
			// the first run for no gain.
			"--default-index", "https://pypi.org/simple", "--no-header",
		],
		{
			input: `${requirements.join("\n")}\n`,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${LOCKFILE}: dependency resolution failed: ${result.stderr}`);
	}
	if (!result.stdout.trim()) throw new Error(`${LOCKFILE}: resolver produced an empty lockfile`);
	return `${header.join("\n")}\n${result.stdout}`;
}

export async function syncRequirementsCiHashes({ root = process.cwd(), runImpl = spawnSync } = {}) {
	const path = join(root, LOCKFILE);
	const source = await readFile(path, "utf8");
	const updated = await updateLockfileContent(source, runImpl);
	if (updated !== source) await writeFile(path, updated);
	return { path, updated: updated !== source };
}

async function main() {
	const result = await syncRequirementsCiHashes();
	process.stdout.write(`requirements-ci.lock: ${result.updated ? "lock recompiled" : "lock current"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
