import { mkdir, readdir, rm } from "node:fs/promises";
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
} finally { await rm(compiled, { recursive: true, force: true }); }
