import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const source = await fs.readFile(new URL('../tv/home.sh', import.meta.url), 'utf8');
const HOME = 'com.webos.app.home';

// `home.sh early` for the webOS 25/26 manifest method in a temporary root. SAM, the bind mount
// and /proc are simulated: a mount makes LG's Home folder a symlink to the stage (same inode for
// stat), a release after a block makes SAM "reread" whatever is mounted, and LG's running Home is
// a fake /proc entry with a Flutter client command line.
async function fixture({
  enabled = true,
  method = 'manifest',
  lgHome = false,
  lateLgHome = false,
  refuseBlock = false,
  stuckSam = false,
  foreign = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'luma-home-early-'));
  const dir = (p) => path.join(root, p);
  const state = dir('state');
  const apps = dir('apps');
  const target = path.join(apps, HOME);
  const proc = dir('proc');
  const bin = dir('bin');
  const sam = dir('sam');
  const calls = dir('calls');
  for (const d of [
    state,
    path.join(state, 'app'),
    target,
    proc,
    bin,
    sam,
    dir('run'),
    dir('app'),
  ]) {
    await fs.mkdir(d, { recursive: true });
  }
  const write = (file, text, mode = 0o644) => fs.writeFile(file, text, { mode });
  await write(path.join(target, 'appinfo.json'), '{"id":"com.webos.app.home","type":"flutter"}');
  await write(path.join(state, 'app', 'appinfo.json'), '{"id":"com.webos.app.home","main":"luma"}');
  await write(path.join(state, 'app', '.luma-home'), 'com.ecklf.luma\n');
  await write(dir('app/luma'), '', 0o755);
  await write(
    path.join(state, 'state.json'),
    `{\n  "enabled": ${enabled},\n  "method": "${method}",\n  "appDir": "${dir('app')}",\n  "stock": {\n    "id": "${HOME}"\n  },\n  "homeId": "${HOME}"\n}\n`,
  );
  await write(
    dir('schema.json'),
    '{"properties":{"id":{},"forceBlockSystemApp":{"type":"boolean"}}}',
  );
  await write(path.join(proc, 'uptime'), '12.34 20.00\n');
  await write(
    path.join(proc, 'mounts'),
    foreign ? `/dev/x ${target} ext4 rw 0 0\n` : '/dev/root / ext4 ro 0 0\n',
  );
  const lgProcess = async (pid) => {
    await fs.mkdir(path.join(proc, pid));
    await write(path.join(proc, pid, 'cmdline'), `/usr/bin/flutter-client\0-i\0${HOME}\0`);
  };
  // A normal process and Luma itself must never be stopped.
  await fs.mkdir(path.join(proc, '200'));
  await write(
    path.join(proc, '200', 'cmdline'),
    `/usr/bin/flutter-client\0-i\0com.webos.app.hdmi2\0`,
  );
  await fs.mkdir(path.join(proc, '201'));
  await write(path.join(proc, '201', 'cmdline'), `${dir('app/luma')}\0{"nid":"${HOME}"}\0`);
  if (lgHome) await lgProcess('300');

  const stub = (name, body) => write(path.join(bin, name), `#!/bin/sh\n${body}\n`, 0o755);
  await stub('id', 'echo 0');
  await stub('usleep', 'exit 0');
  await stub('sleep', 'exit 0');
  await stub('stat', `if [ "$1 $2" = "-c %u" ]; then echo 0; else exec /usr/bin/stat -L "$@"; fi`);
  await stub('kill', `echo "kill $*" >>'${calls}'; rm -rf '${proc}'/"$1"`);
  await stub(
    'mount',
    `echo "mount $*" >>'${calls}'
rm -rf "$3" && ln -s "$2" "$3" && echo "$2 $3 none rw,bind 0 0" >>'${proc}/mounts'`,
  );
  await stub(
    'umount',
    `t=$1; [ "$t" = -l ] && t=$2
echo "umount $*" >>'${calls}'
rm -f "$t" && mkdir "$t" && echo '{"id":"${HOME}","type":"flutter"}' >"$t/appinfo.json"
grep -v " $t " '${proc}/mounts' >'${proc}/mounts.new'; mv '${proc}/mounts.new' '${proc}/mounts'`,
  );
  await stub(
    'luna-send',
    `for last; do :; done
uri=$(printf '%s\\n' "$@" | grep '^luna://')
method=\${uri##*/}
echo "luna $method $last" >>'${calls}'
case $method in
  blockSystemApp)
    ${refuseBlock ? `echo '{"returnValue":false,"errorText":"Permission denied"}'; exit 0` : ':'}
    touch '${sam}/blocked'; echo '{"returnValue":true}' ;;
  releaseBlockSystemApp)
    if [ -f '${sam}/blocked' ] && [ ! -f '${sam}/stuck' ]; then
      if [ -L '${target}' ]; then echo luma >'${sam}/manifest'; else rm -f '${sam}/manifest'; fi
    fi
    rm -f '${sam}/blocked'; echo '{"returnValue":true}' ;;
  getAppInfo)
    if [ -f '${sam}/manifest' ]; then
      echo '{"appInfo":{"id":"${HOME}","main":"file://${state}/app/luma","type":"native","appCategory":["home"]},"returnValue":true}'
    else
      echo '{"appInfo":{"id":"${HOME}","main":"/usr/palm/applications/${HOME}/","type":"flutter"},"returnValue":true}'
    fi ;;
  launch) echo '{"returnValue":true}' ;;
  getBootStatus)
    ${
      lateLgHome
        ? `if [ ! -f '${sam}/late' ]; then touch '${sam}/late'; mkdir '${proc}/400'; printf '/usr/bin/flutter-client\\0-i\\0${HOME}\\0' >'${proc}/400/cmdline'; fi`
        : ':'
    }
    echo '{"firstAppLaunched":true,"returnValue":true}' ;;
  *) echo '{"returnValue":false,"errorText":"unexpected"}' ;;
esac`,
  );
  if (stuckSam) await write(path.join(sam, 'stuck'), '');
  await write(path.join(state, 'luma-helper'), `#!/bin/sh\necho "helper $*" >>'${calls}'\n`, 0o755);

  const line = 'STATE=/var/lib/luma-home\n';
  assert.ok(source.includes(line));
  const script = source
    .replace(line, `STATE='${state}'\n`)
    .replaceAll('/usr/bin/luna-send', path.join(bin, 'luna-send'))
    .replaceAll('/usr/palm/applications/', `${apps}/`)
    .replaceAll('/var/run/', `${dir('run')}/`)
    .replaceAll(
      '/etc/palm/schemas/sam/applicationManager.blockSystemApp.schema',
      dir('schema.json'),
    )
    .replaceAll('/proc/', `${proc}/`)
    // kill is a shell builtin: never signal the host's processes.
    .replaceAll('kill "$pid"', `'${path.join(bin, 'kill')}' "$pid"`);
  await write(path.join(state, 'home.sh'), script, 0o755);
  const run = (command) =>
    spawnSync('/bin/sh', [path.join(state, 'home.sh'), command], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      timeout: 20000,
    });
  const read = async (file) => fs.readFile(file, 'utf8').catch(() => '');
  // The background guard after a successful takeover: wait until it stopped asking bootd.
  const settle = async () => {
    let last = '';
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const now = await read(calls);
      if (now === last && i > 4) return;
      last = now;
    }
  };
  return {
    root,
    target,
    run,
    settle,
    calls: async () => (await read(calls)).trim().split('\n').filter(Boolean),
    log: () => read(path.join(state, 'boot.log')),
    marker: () => read(dir('run/luma-home-early')),
    mounted: async () => (await fs.lstat(target)).isSymbolicLink(),
    alive: async (pid) =>
      fs.access(path.join(proc, pid)).then(
        () => true,
        () => false,
      ),
    done: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('before LG Home starts: blocked, mounted, released and reread, nothing stopped or launched', async () => {
  const tv = await fixture();
  try {
    const early = tv.run('early');
    assert.equal(early.status, 0, early.stderr);
    await tv.settle();
    const calls = await tv.calls();
    const order = calls.filter((c) => /SystemApp|^mount/.test(c)).map((c) => c.split(' ')[1]);
    assert.deepEqual(order.slice(0, 3), ['blockSystemApp', '--bind', 'releaseBlockSystemApp']);
    assert.ok(
      calls.includes('luna blockSystemApp {"id":"com.webos.app.home","forceBlockSystemApp":false}'),
    );
    assert.ok(calls.some((c) => c.startsWith('luna getAppInfo')));
    assert.ok(await tv.mounted());
    assert.equal(calls.filter((c) => c.startsWith('kill')).length, 0);
    assert.equal(calls.filter((c) => c.startsWith('luna launch')).length, 0);
    assert.equal(await tv.marker(), 'manifest\n');
    assert.match(await tv.log(), /early: Luma is Home \(before LG Home started\)/);
  } finally {
    await tv.done();
  }
});

test('LG Home already running: only LG Home is stopped, then Home is launched', async () => {
  const tv = await fixture({ lgHome: true });
  try {
    const early = tv.run('early');
    assert.equal(early.status, 0, early.stderr);
    await tv.settle();
    const calls = await tv.calls();
    assert.deepEqual(
      calls.filter((c) => c.startsWith('kill')),
      ['kill 300'],
    );
    assert.ok(await tv.alive('200'));
    assert.ok(await tv.alive('201'));
    assert.ok(calls.includes('luna launch {"id":"com.webos.app.home"}'));
    assert.match(await tv.log(), /stopped and replaced/);
  } finally {
    await tv.done();
  }
});

test('an LG Home that bootd starts after the takeover is replaced by the guard', async () => {
  const tv = await fixture({ lateLgHome: true });
  try {
    const early = tv.run('early');
    assert.equal(early.status, 0, early.stderr);
    await tv.settle();
    const calls = await tv.calls();
    assert.ok(calls.includes('kill 400'));
    assert.ok(calls.includes('luna launch {"id":"com.webos.app.home"}'));
    assert.ok(!(await tv.alive('400')));
    assert.match(await tv.log(), /replaced a late LG Home/);
  } finally {
    await tv.done();
  }
});

test('SAM never rereads: unmounted, released again, failure left to the boot hook', async () => {
  const tv = await fixture({ stuckSam: true });
  try {
    const early = tv.run('early');
    assert.equal(early.status, 1);
    const calls = await tv.calls();
    assert.ok(!(await tv.mounted()));
    assert.ok(calls.some((c) => c.startsWith('umount')));
    assert.equal(calls.filter((c) => c.startsWith('luna blockSystemApp')).length, 2);
    assert.equal(calls.at(-1).split(' ')[1], 'releaseBlockSystemApp');
    assert.equal(await tv.marker(), '');
    assert.match(await tv.log(), /failed: SAM did not read the Luma manifest/);
  } finally {
    await tv.done();
  }
});

test('a refused block changes nothing', async () => {
  const tv = await fixture({ refuseBlock: true });
  try {
    const early = tv.run('early');
    assert.equal(early.status, 1);
    const calls = await tv.calls();
    assert.ok(!(await tv.mounted()));
    assert.equal(calls.filter((c) => c.startsWith('mount')).length, 0);
    assert.equal(await tv.marker(), '');
  } finally {
    await tv.done();
  }
});

test('another integration mounted over LG Home is left alone', async () => {
  const tv = await fixture({ foreign: true });
  try {
    const early = tv.run('early');
    assert.equal(early.status, 1);
    assert.deepEqual(await tv.calls(), []);
  } finally {
    await tv.done();
  }
});

test('disabled integration: early does nothing', async () => {
  const tv = await fixture({ enabled: false });
  try {
    assert.equal(tv.run('early').status, 1);
    assert.deepEqual(await tv.calls(), []);
  } finally {
    await tv.done();
  }
});

test('after an early takeover the boot hook skips its apply; without one it schedules it', async () => {
  const tv = await fixture();
  try {
    assert.equal(tv.run('early').status, 0);
    await tv.settle();
    const before = (await tv.calls()).length;
    assert.equal(tv.run('boot').status, 0);
    await tv.settle();
    assert.equal((await tv.calls()).length, before);
  } finally {
    await tv.done();
  }
  const cold = await fixture();
  try {
    assert.equal(cold.run('boot').status, 0);
    // Up to a real 5 s sleep where the shell runs sleep as a builtin (busybox ash).
    let applied = false;
    for (let i = 0; i < 140 && !applied; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      applied = (await cold.calls()).some((c) => c.startsWith('helper home apply'));
    }
    assert.ok(applied);
  } finally {
    await cold.done();
  }
});
