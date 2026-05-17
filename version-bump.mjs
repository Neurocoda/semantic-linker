import fs from "node:fs";
import process from "node:process";

const packagePath = "package.json";
const manifestPath = "manifest.json";
const versionsPath = "versions.json";

const packageJson = readJson(packagePath);
const manifest = readJson(manifestPath);
const versions = readJson(versionsPath);
const nextVersion = process.env.npm_package_version ?? packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
	console.error(`Version must use x.y.z format, received '${nextVersion}'.`);
	process.exit(1);
}

manifest.version = nextVersion;
versions[nextVersion] = manifest.minAppVersion;

writeJson(manifestPath, manifest);
writeJson(versionsPath, sortVersionMap(versions));

function readJson(path) {
	return JSON.parse(fs.readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	fs.writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function sortVersionMap(value) {
	return Object.fromEntries(
		Object.entries(value).sort(([a], [b]) => compareSemver(a, b))
	);
}

function compareSemver(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) {
			return delta;
		}
	}
	return 0;
}
