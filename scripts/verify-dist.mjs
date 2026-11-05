import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
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
  for (const name of await readdir(temporary)) {
    if (!name.endsWith(".hbs")) continue;
    const path = join(temporary, name);
    const text = (await readFile(path, "utf8")).trimEnd();
    await writeFile(path, text ? text + "\n" : "");
  }
  const list = async (root, prefix = '') => {
    const result = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = join(prefix, entry.name);
      if (entry.isDirectory()) result.push(...await list(root, path));
      else if (entry.isFile()) result.push(path);
      else throw new Error('Unexpected dist file mode');
    }
    return result.sort();
  };
  const [actualPaths, rebuiltPaths] = await Promise.all([list('packages/runner/dist'), list(temporary)]);
  if (JSON.stringify(actualPaths) !== JSON.stringify(rebuiltPaths)) throw new Error('runner dist assets differ');
  for (const path of actualPaths) {
    const [actual, rebuilt] = await Promise.all([readFile(join('packages/runner/dist', path)), readFile(join(temporary, path))]);
    if (!actual.equals(rebuilt)) throw new Error(`packages/runner/dist/${path}不是当前源代码的可重复构建结果`);
  }
  console.log("runner dist verified");
} finally { await Promise.all([rm(temporary, { recursive: true, force: true }), rm(compiled, { recursive: true, force: true })]); }
