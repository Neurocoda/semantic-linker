import fs from "node:fs";
import process from "node:process";

const requiredFiles = [
	"README.md",
	"LICENSE",
	"manifest.json",
	"package.json",
	"versions.json"
];

const releaseAssets = [
	"main.js",
	"manifest.json",
	"styles.css"
];

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const failures = [];

for (const file of requiredFiles) {
	if (!fs.existsSync(file)) {
		failures.push(`Missing required repository file: ${file}`);
	}
}

if (manifest.id !== packageJson.name) {
	failures.push(`manifest.id (${manifest.id}) must match package.json name (${packageJson.name}).`);
}

if (manifest.version !== packageJson.version) {
	failures.push(`manifest version (${manifest.version}) must match package.json version (${packageJson.version}).`);
}

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
	failures.push(`manifest version must use x.y.z format: ${manifest.version}`);
}

if (versions[manifest.version] !== manifest.minAppVersion) {
	failures.push(`versions.json must map ${manifest.version} to ${manifest.minAppVersion}.`);
}

if (manifest.id.includes("obsidian")) {
	failures.push("Plugin id must not contain 'obsidian'.");
}

if (manifest.description.length > 250) {
	failures.push("manifest description must be 250 characters or fewer.");
}

if (!manifest.description.endsWith(".")) {
	failures.push("manifest description should end with a period.");
}

for (const asset of releaseAssets) {
	if (!fs.existsSync(asset)) {
		failures.push(`Release asset is missing; run npm run build first: ${asset}`);
	}
}

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}

console.log(`Release check passed for ${manifest.id} ${manifest.version}.`);

function readJson(path) {
	return JSON.parse(fs.readFileSync(path, "utf8"));
}
