import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const temporary = ".runner-dist-verify";
const compiled = ".runner-build";
try {
  await Promise.all([rm(temporary, { recursive: true, force: true }), rm(compiled, { recursive: true, force: true })]);
  await mkdir(temporary, { recursive: true });
  let child = spawn(process.execPath, ["node_modules/typescript/bin/tsc", "--outDir", compiled, "--noEmit", "false", "--declaration", "false", "--sourceMap", "false"], { stdio: "inherit" });
  let code = await new Promise(resolve => child.on("close", resolve));
  if (code !== 0) process.exit(code ?? 1);
  child = spawn(process.execPath, ["node_modules/@vercel/ncc/dist/ncc/cli.js", "build", join(compiled, "packages/runner/src/index.js"), "-o", temporary, "--minify"], { stdio: "inherit" });
  code = await new Promise(resolve => child.on("close", resolve));
  if (code !== 0) process.exit(code ?? 1);
  const [actual, rebuilt] = await Promise.all([readFile("packages/runner/dist/index.js"), readFile(join(temporary, "index.js"))]);
  if (!actual.equals(rebuilt)) throw new Error("packages/runner/dist/index.js不是当前源代码的可重复构建结果");
  console.log("runner dist verified");
} finally { await Promise.all([rm(temporary, { recursive: true, force: true }), rm(compiled, { recursive: true, force: true })]); }
