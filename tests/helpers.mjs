// Loads a .ts module the way pi loads extensions: through jiti with the
// @earendil-works aliases. The managed install is preferred (the real
// runtime); the repo's own node_modules (devDependency jiti) is the fallback
// that keeps tests green on machines with no pi install.
// Ported from pi-cdd's tests/pi-jiti.mjs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function repoFile(...parts) {
	return path.join(REPO, ...parts);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Promise-based wait for one event; rejects on timeout so tests fail loudly. */
export function once(emitter, event, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`once(${event}) timed out after ${timeoutMs}ms`)), timeoutMs);
		emitter.once(event, (e) => {
			clearTimeout(t);
			resolve(e);
		});
	});
}

export async function loadViaPi(tsPath) {
	const nodeModulesDirs = [];

	const roots = [process.env.PI_MANAGED_INSTALL_ROOT, path.join(os.homedir(), ".pi", "agent", "install")].filter(
		Boolean,
	);

	for (const r of roots) {
		const rel = path.resolve(r, "releases");

		if (!fs.existsSync(rel)) continue;
		const ver = fs.readdirSync(rel).sort().at(-1);
		const nm = path.join(rel, ver, "node_modules");

		if (fs.existsSync(path.join(nm, "jiti", "lib", "jiti.mjs"))) nodeModulesDirs.push(nm);
	}

	const local = path.join(REPO, "node_modules");

	if (fs.existsSync(path.join(local, "jiti", "lib", "jiti.mjs"))) nodeModulesDirs.push(local);

	for (const nm of nodeModulesDirs) {
		const { createJiti } = await import(path.join(nm, "jiti", "lib", "jiti.mjs"));

		const jiti = createJiti(import.meta.url, {
			alias: {
				"@earendil-works/pi-tui": path.join(nm, "@earendil-works", "pi-tui", "dist", "index.js"),
				"@earendil-works/pi-ai": path.join(nm, "@earendil-works", "pi-ai", "dist", "index.js"),
				"@earendil-works/pi-coding-agent": path.join(nm, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
			},
		});

		return await jiti.import(tsPath);
	}

	throw new Error("no jiti found (neither pi install nor local node_modules)");
}
