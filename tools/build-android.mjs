// Builds the Android shell with the official SDK command-line tools only (no Gradle).
//   node tools/build-android.mjs
// Needs ANDROID_HOME (build-tools 36.x, platforms/android-36) and JAVA_HOME (JDK 17+);
// defaults to runtime/android-sdk and runtime/jdk. Output: build/android/AllinOne.apk.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sdk = process.env.ANDROID_HOME ?? join(root, 'runtime', 'android-sdk');
const jdk = process.env.JAVA_HOME ?? join(root, 'runtime', 'jdk');
const app = join(root, 'android');
const out = join(root, 'build', 'android');
const keys = join(root, 'data', 'android-signing');

const tools = join(sdk, 'build-tools', readdirSync(join(sdk, 'build-tools')).filter((v) => v.startsWith('36')).sort().at(-1));
const platform = join(sdk, 'platforms', 'android-36', 'android.jar');
const exe = (dir, name) => join(dir, process.platform === 'win32' ? name + (name === 'd8' || name === 'apksigner' ? '.bat' : '.exe') : name);
const java = (name) => join(jdk, 'bin', process.platform === 'win32' ? name + '.exe' : name);

function run(cmd, args) {
  console.log('>', cmd.split(/[\\/]/).pop(), args.slice(0, 3).join(' '), args.length > 3 ? '…' : '');
  // .bat files must go through cmd.exe; none of our paths contain spaces. d8/apksigner find Java via JAVA_HOME.
  const env = { ...process.env, JAVA_HOME: jdk };
  if (cmd.endsWith('.bat')) execFileSync('cmd.exe', ['/d', '/c', cmd, ...args], { stdio: 'inherit', env });
  else execFileSync(cmd, args, { stdio: 'inherit', env });
}

function files(dir, ext) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
  });
}

const version = JSON.parse(readFileSync(join(app, 'version.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
for (const d of ['gen', 'classes', 'dex']) mkdirSync(join(out, d), { recursive: true });

run(exe(tools, 'aapt2'), ['compile', '--dir', join(app, 'res'), '-o', join(out, 'res.zip')]);
run(exe(tools, 'aapt2'), ['link', '-o', join(out, 'base.apk'), '--manifest', join(app, 'AndroidManifest.xml'), '-I', platform,
  '--java', join(out, 'gen'), '-A', join(app, 'assets'), '--min-sdk-version', '30', '--target-sdk-version', '36',
  '--version-code', String(version.code), '--version-name', version.name, join(out, 'res.zip')]);
run(java('javac'), ['--release', '17', '-encoding', 'UTF-8', '-Xlint:-options', '-classpath', platform, '-d', join(out, 'classes'),
  ...files(join(app, 'src'), '.java'), ...files(join(out, 'gen'), '.java')]);
run(exe(tools, 'd8'), ['--release', '--min-api', '30', '--lib', platform, '--output', join(out, 'dex'), ...files(join(out, 'classes'), '.class')]);
run(java('jar'), ['uf', join(out, 'base.apk'), '-C', join(out, 'dex'), 'classes.dex']);
run(exe(tools, 'zipalign'), ['-f', '-p', '4', join(out, 'base.apk'), join(out, 'aligned.apk')]);

// One signing key for the life of the app. Back up data/android-signing: without it, updates cannot be installed over the app.
const store = join(keys, 'release.jks');
const passFile = join(keys, 'password.txt');
if (!existsSync(store)) {
  mkdirSync(keys, { recursive: true });
  writeFileSync(passFile, randomBytes(24).toString('base64url'));
  const pass = readFileSync(passFile, 'utf8');
  run(java('keytool'), ['-genkeypair', '-keystore', store, '-alias', 'allinone', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '36500',
    '-dname', 'CN=AllinOne', '-storepass', pass, '-keypass', pass]);
  console.log('\n*** 新的签名密钥已生成：' + keys + '\n*** 请把这个文件夹备份到安全的地方；丢了它，以后就无法覆盖升级 App。\n');
}
// The key shares the keystore password, so --key-pass is omitted (apksigner reads one line per password option).
run(exe(tools, 'apksigner'), ['sign', '--ks', store, '--ks-key-alias', 'allinone', '--ks-pass', `file:${passFile}`,
  '--out', join(out, 'AllinOne.apk'), join(out, 'aligned.apk')]);
run(exe(tools, 'apksigner'), ['verify', join(out, 'AllinOne.apk')]);
console.log('\nAPK:', join(out, 'AllinOne.apk'), `(${version.name}, code ${version.code})`);
