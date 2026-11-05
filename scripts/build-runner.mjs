import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const compiled = ".runner-build";
try {
  await rm(compiled, { recursive: true, force: true });
  await mkdir("packages/runner/dist", { recursive: true });
  for (const name of await readdir("packages/runner/dist")) await rm(join("packages/runner/dist", name), { recursive: true, force: true });
  let child = spawn(process.execPath, ["node_modules/typescript/bin/tsc", "--outDir", compiled, "--noEmit", "false", "--declaration", "false", "--sourceMap", "false"], { stdio: "inherit" });
  let code = await new Promise(resolve => child.on("close", resolve));
  if (code !== 0) process.exit(code ?? 1);
  child = spawn(process.execPath, ["node_modules/@vercel/ncc/dist/ncc/cli.js", "build", join(compiled, "packages/runner/src/index.js"), "-o", "packages/runner/dist", "--minify"], { stdio: "inherit" });
  code = await new Promise(resolve => child.on("close", resolve));
  if (code !== 0) process.exit(code ?? 1);
  // Release Please reads its packaged Handlebars templates at runtime. Keep all
  // ncc assets and verify their bytes alongside index.js.
  for (const name of await readdir("packages/runner/dist")) {
    if (!name.endsWith(".hbs")) continue;
    const path = join("packages/runner/dist", name);
    const text = (await readFile(path, "utf8")).trimEnd();
    await writeFile(path, text ? text + "\n" : "");
  }
} finally { await rm(compiled, { recursive: true, force: true }); }
