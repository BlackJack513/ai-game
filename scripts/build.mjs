// 用 TypeScript 编译器 API 编译，不依赖任何打包器，也不需要 spawn 子进程。
//   node scripts/build.mjs          -> 编译 src/ 到 js/（浏览器直接加载）
//   node scripts/build.mjs --test   -> 编译 src/ + scripts/ 到 .test-build/（跑自测）
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function build({ test = false, quiet = false } = {}) {
  const configPath = path.join(root, test ? 'tsconfig.test.json' : 'tsconfig.build.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    console.error(ts.formatDiagnosticsWithColorAndContext([read.error], host));
    return false;
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: false });
  const emitResult = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, host);
    console.error(formatted);
    return false;
  }
  if (!quiet) {
    console.log(`✓ 编译通过 -> ${test ? '.test-build/' : 'js/'} (${parsed.fileNames.length} 个文件)`);
  }
  return true;
}

const host = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
};

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const ok = build({ test: process.argv.includes('--test') });
  if (!ok) process.exit(1);
}
