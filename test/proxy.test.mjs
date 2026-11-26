import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  buildProxyEnv,
  checkLocalPort,
  detectLocalProxy,
  formatShellExports,
  launchAgyWithProxy,
  normalizeProxyConfig,
  parseRunArgs,
  parseScutilProxy,
  parseWindowsRegProxy,
  redactProxyUrl,
  resolveEffectiveProxy,
  validateProxyUrl,
} from '../src/proxy.mjs';

test('validateProxyUrl normalizes bare host:port, warns on socks5, and rejects invalid URLs', () => {
  const bare = validateProxyUrl('127.0.0.1:7897');
  assert.equal(bare.url, 'http://127.0.0.1:7897');
  assert.equal(bare.host, '127.0.0.1');
  assert.equal(bare.port, 7897);
  assert.equal(bare.warning, null);

  const socks = validateProxyUrl('socks5://127.0.0.1:1080');
  assert.equal(socks.url, 'socks5://127.0.0.1:1080');
  assert.equal(socks.protocol, 'socks5');
  assert.match(socks.warning, /HTTP CONNECT/);

  assert.throws(() => validateProxyUrl(''), /cannot be empty/);
  assert.throws(() => validateProxyUrl('ftp://127.0.0.1:21'), /Unsupported proxy protocol/);
  assert.throws(() => validateProxyUrl('http://'), /Invalid proxy URL/);
});

test('redactProxyUrl masks embedded credentials while leaving plain URLs intact', () => {
  assert.equal(redactProxyUrl('http://alice:s3cr3t@127.0.0.1:7897'), 'http://***@127.0.0.1:7897');
  assert.equal(redactProxyUrl('http://127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(redactProxyUrl(null), null);
});

test('parseScutilProxy extracts HTTP/HTTPS proxy over SOCKS and normalizes ExceptionsList', () => {
  const macOutput = `
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
    4 : <local>
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}
`;
  const parsed = parseScutilProxy(macOutput);
  assert.equal(parsed.url, 'http://127.0.0.1:7897');
  assert.ok(parsed.bypass.includes('127.0.0.1'));
  assert.ok(parsed.bypass.includes('::1'));
  assert.ok(parsed.bypass.includes('.local'));
  assert.ok(!parsed.bypass.includes('<local>'));

  const disabled = parseScutilProxy('<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  SOCKSEnable : 0\n}');
  assert.equal(disabled, null);
});

test('parseWindowsRegProxy handles single host:port, protocol map, and disabled state', () => {
  const simple = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride  REG_SZ    localhost;127.*;*.local;<local>
`;
  const parsedSimple = parseWindowsRegProxy(simple);
  assert.equal(parsedSimple.url, 'http://127.0.0.1:7890');
  assert.ok(parsedSimple.bypass.includes('.local'));
  assert.ok(!parsedSimple.bypass.includes('<local>'));

  const mapped = `
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808
`;
  assert.equal(parseWindowsRegProxy(mapped).url, 'http://127.0.0.1:10809');

  const off = `
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
`;
  assert.equal(parseWindowsRegProxy(off), null);
});

test('detectLocalProxy falls back to priority-ordered localhost port probe when OS proxy is off', async () => {
  const detected = await detectLocalProxy({
    platform: 'darwin',
    execCmd: () => 'HTTPEnable : 0\nHTTPSEnable : 0\nSOCKSEnable : 0\n',
    probePort: async (_host, port) => ({
      reachable: port === 7890 || port === 1080,
      latencyMs: 1,
      error: null,
    }),
  });
  assert.equal(detected.url, 'http://127.0.0.1:7890');
  assert.match(detected.source, /7890/);

  const none = await detectLocalProxy({
    platform: 'linux',
    probePort: async () => ({ reachable: false, latencyMs: 1, error: 'ECONNREFUSED' }),
  });
  assert.equal(none, null);
});

test('buildProxyEnv populates uppercase/lowercase proxy vars and preserves loopback NO_PROXY', async () => {
  const resolved = await resolveEffectiveProxy(
    normalizeProxyConfig({ mode: 'manual', url: 'http://127.0.0.1:7897', bypass: ['.corp.internal'] }),
  );
  const env = buildProxyEnv(resolved, { PATH: '/usr/bin', NO_PROXY: '10.0.0.1' });

  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(env[key], 'http://127.0.0.1:7897');
  }
  assert.equal(env.NO_PROXY, env.no_proxy);
  assert.ok(env.NO_PROXY.includes('127.0.0.1'));
  assert.ok(env.NO_PROXY.includes('localhost'));
  assert.ok(env.NO_PROXY.includes('::1'));
  assert.ok(env.NO_PROXY.includes('.corp.internal'));
  assert.ok(env.NO_PROXY.includes('10.0.0.1'));

  const stripped = buildProxyEnv({ active: false }, { HTTP_PROXY: 'http://old:1234', PATH: '/usr/bin' }, { stripExisting: true });
  assert.equal(stripped.HTTP_PROXY, undefined);
  assert.equal(stripped.PATH, '/usr/bin');
});

test('formatShellExports formats sh, fish, and PowerShell commands cleanly', () => {
  const active = { active: true, url: 'http://127.0.0.1:7897', bypass: ['127.0.0.1', 'localhost', '::1'] };
  const sh = formatShellExports(active, { shell: 'sh' });
  assert.match(sh, /export HTTPS_PROXY='http:\/\/127\.0\.0\.1:7897'/);
  assert.match(sh, /export NO_PROXY='127\.0\.0\.1,localhost,::1'/);

  const fish = formatShellExports(active, { shell: 'fish' });
  assert.match(fish, /set -gx HTTPS_PROXY 'http:\/\/127\.0\.0\.1:7897'/);

  const pwsh = formatShellExports(active, { shell: 'pwsh' });
  assert.match(pwsh, /\$env:HTTPS_PROXY = 'http:\/\/127\.0\.0\.1:7897'/);

  assert.match(formatShellExports({ active: false }, { shell: 'sh' }), /^unset HTTP_PROXY/);
});

test('parseRunArgs parses leading wrapper flags and forwards all remaining agy args untouched', () => {
  const parsed = parseRunArgs(['--proxy', '127.0.0.1:7897', '-q', '-c', '--dangerously-skip-permissions', '--help']);
  assert.equal(parsed.options.proxyUrl, '127.0.0.1:7897');
  assert.equal(parsed.options.quiet, true);
  assert.deepEqual(parsed.agyArgs, ['-c', '--dangerously-skip-permissions', '--help']);

  const withDashDash = parseRunArgs(['--no-proxy', '--', '--proxy', 'literal-for-agy']);
  assert.equal(withDashDash.options.noProxy, true);
  assert.deepEqual(withDashDash.agyArgs, ['--proxy', 'literal-for-agy']);
});

test('checkLocalPort and launchAgyWithProxy verify TCP reachability and inject proxy env vars into child', async () => {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const up = await checkLocalPort('127.0.0.1', port, 500);
    assert.equal(up.reachable, true);

    const stderrChunks = [];
    const stderr = { write: (s) => stderrChunks.push(s) };
    const proxyUrl = `http://127.0.0.1:${port}`;

    // Verify real child receives all proxy vars + wrapper guard and returns exit code cleanly.
    const script = [
      `if (process.env.HTTPS_PROXY !== ${JSON.stringify(proxyUrl)}) process.exit(2);`,
      `if (process.env.http_proxy !== ${JSON.stringify(proxyUrl)}) process.exit(3);`,
      `if (!process.env.NO_PROXY.includes('127.0.0.1')) process.exit(4);`,
      `if (process.env.AGY_BAR_PROXY_WRAPPER !== '1') process.exit(5);`,
      `process.exit(0);`,
    ].join(' ');

    const res = await launchAgyWithProxy(['--agy-bin', process.execPath, '-e', script], {
      proxyConfig: { mode: 'manual', url: proxyUrl, bypass: ['127.0.0.1', 'localhost', '::1'] },
      env: { PATH: process.env.PATH },
      stderr,
    });
    assert.equal(res.exitCode, 0);
    assert.match(stderrChunks.join(''), /no-TUN/);

    // Verify --no-proxy strips inherited proxy env vars.
    const noProxyScript = `process.exit(process.env.HTTPS_PROXY ? 9 : 0);`;
    const directRes = await launchAgyWithProxy(['--no-proxy', '--quiet', '--agy-bin', process.execPath, '-e', noProxyScript], {
      proxyConfig: { mode: 'manual', url: proxyUrl, bypass: ['127.0.0.1'] },
      env: { PATH: process.env.PATH, HTTPS_PROXY: proxyUrl },
      stderr,
    });
    assert.equal(directRes.exitCode, 0);

    // Verify recursion guard prevents infinite loop.
    await assert.rejects(
      () => launchAgyWithProxy(['--version'], { proxyConfig: { mode: 'off' }, env: { AGY_BAR_PROXY_WRAPPER: '1' } }),
      /recursive agy-bar run/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // After closing server, manual proxy must fail fast with redacted credentials.
  await assert.rejects(
    () =>
      launchAgyWithProxy(['--agy-bin', process.execPath, '-v'], {
        proxyConfig: { mode: 'manual', url: `http://user:secret@127.0.0.1:${port}`, bypass: ['127.0.0.1'] },
        env: { PATH: process.env.PATH },
      }),
    (err) => {
      assert.match(err.message, /not listening/);
      assert.ok(err.message.includes('***@'));
      assert.ok(!err.message.includes('secret'));
      return true;
    },
  );
});
