import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOCKFILE = "requirements-ci.lock";
// CI installs pre-commit; # via comments and unannotated entries are not roots.
const ROOT_PACKAGES = ["pre-commit"];
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
		requirements.push(requirement);
	}
	if (requirements.length === 0) return source;

	const roots = ROOT_PACKAGES.map((name) => {
		const requirement = requirements.find((entry) => entry.name.toLowerCase().replace(/[_.]+/g, "-") === name);
		if (!requirement) throw new Error(`${LOCKFILE}: missing CI root ${name}`);
		return requirement.spec;
	});
	// Constraints retain Renovate's pins only while a package is still needed.
	// Extras belong on root requirements, not in uv's constraints file.
	const directory = await mkdtemp(join(tmpdir(), "ci-lock-"));
	try {
		const constraints = join(directory, "constraints.txt");
		await writeFile(constraints, `${requirements.map((entry) => entry.spec.replace(/\[[^\]]*\]/, "")).join("\n")}\n`);
		// Only sanitized pins cross the PR boundary: no config or build hooks.
		const result = await runImpl(
			"uv",
			[
				"--no-config", "pip", "compile", "-", "--generate-hashes",
				"--python-version", "3.13", "--only-binary", ":all:",
				"--default-index", "https://pypi.org/simple", "--no-header",
				"--constraint", constraints,
			],
			{
				input: `${roots.join("\n")}\n`,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`${LOCKFILE}: dependency resolution failed: ${result.stderr}`);
		}
		if (!result.stdout.trim()) throw new Error(`${LOCKFILE}: resolver produced an empty lockfile`);
		// uv annotates constraint sources; never persist a random temp path.
		return `${header.join("\n")}\n${result.stdout.replaceAll(constraints, LOCKFILE)}`;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
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
