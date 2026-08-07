// Ad-hoc sign the packaged app.
//
// Electron ships its binaries already signed. Packaging rewrites the bundle
// (rename, Info.plist, extra resources), which invalidates that signature —
// and macOS on Apple Silicon refuses to launch an arm64 bundle whose signature
// does not verify, with the famously unhelpful "app is damaged and can't be
// opened. You should move it to the Trash."
//
// Quarantine removal does not fix that: the signature itself is broken, not the
// download flag. Without a paid Developer ID the fix is an ad-hoc signature
// ("--sign -"), which is free, needs no certificate, and makes the bundle
// verify. Users still see the unidentified-developer prompt once; they no
// longer see a damaged app.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`afterPack: no app bundle at ${appPath}`);

  // --deep is deprecated for real distribution signing but remains the
  // practical way to ad-hoc sign every nested helper and framework at once.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
    stdio: 'inherit',
  });

  // Fail the build rather than ship a bundle that will not launch.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });

  console.log(`  • ad-hoc signed and verified  ${path.basename(appPath)} (${context.arch === 1 ? 'x64' : 'arm64'})`);
};
