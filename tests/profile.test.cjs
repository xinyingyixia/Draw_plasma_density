const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Execute the actual standalone page script, omitting only browser initialization.
function loadPage() {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const context = vm.createContext({
    document: { getElementById: () => ({}) }, window: {}, TextEncoder,
    Uint8Array, Float64Array, ArrayBuffer, DataView
  });
  vm.runInContext(script.replace(/\binit\(\);\s*$/, ''), context);
  return vm.runInContext(`({
    buildDensityProfile, normalizedExp, parseNonNegativeInput,
    defaults: { ...state }, nc: PHYSICS.nc,
    setProfile(p) { latestProfile = p; },
    setState(p) { Object.assign(state, p); },
    exportPlotDataNpZ,
    setExportHooks(zip, toast, download) {
      window.JSZip = zip; globalThis.JSZip = zip;
      showToast = toast; downloadBlob = download;
    }
  })`, context);
}

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Number.isFinite(actual), `Expected finite result, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} differs from ${expected}`);
}

// Independent composite midpoint quadrature of the plotted interpolation.
function integrateRamp(api, start, end, alpha, mode, length) {
  const steps = 10000;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const fraction = mode === 'linear' ? t : api.normalizedExp(t, alpha);
    sum += start + (end - start) * fraction;
  }
  return sum / steps * length * 1e-6;
}

for (const plateau of [0, 100]) {
  for (const [left, right] of [[0, 0], [2, 0], [0, 3], [2, 3]]) {
    for (const enabledL of [false, true]) for (const enabledR of [false, true]) {
      for (const mode of ['linear', 'nc', 'area']) {
        test(`density ${plateau}/${left}/${right}; ramps ${enabledL}/${enabledR}; ${mode}`, () => {
          const api = loadPage();
          const p = { ...api.defaults,
            plateauDensitySI: plateau * api.nc,
            leftStartDensitySI: left * api.nc, rightEndDensitySI: right * api.nc,
            leftRampEnabled: enabledL, rightRampEnabled: enabledR,
            riseMode: mode === 'linear' ? 'linear' : 'exp',
            decayMode: mode === 'linear' ? 'linear' : 'exp',
            riseExpMode: mode, decayExpMode: mode
          };
          const profile = api.buildDensityProfile(p);
          let expected = p.plateauDensitySI * p.plateauLength * 1e-6;
          if (enabledL) expected += integrateRamp(api, p.leftStartDensitySI, p.plateauDensitySI,
            profile.alphaL, profile.effectiveRiseMode, p.riseLength);
          if (enabledR) expected += integrateRamp(api, p.plateauDensitySI, p.rightEndDensitySI,
            profile.alphaR, profile.effectiveDecayMode, p.decayLength);
          near(profile.arealDensitySI, expected, 2e-7);
          assert.ok(profile.ySI.every((n) => Number.isFinite(n) && n >= 0));
          near(profile.arealDensityCM2, profile.arealDensitySI / 1e4);
          if (!plateau && !left && !right) assert.equal(profile.arealDensitySI, 0);
          if (!plateau && mode === 'area') {
            if (enabledL) assert.equal(profile.effectiveRiseMode, 'linear');
            if (enabledR) assert.equal(profile.effectiveDecayMode, 'linear');
          }
        });
      }
    }
  }
}

test('zero is a valid density input', () => {
  const api = loadPage();
  assert.equal(api.parseNonNegativeInput('0'), 0);
});

test('zero plateau retains valid exponential curvature on both sides', () => {
  const api = loadPage();
  const params = { ...api.defaults, plateauDensitySI: 0,
    leftStartDensitySI: 2 * api.nc, rightEndDensitySI: 2 * api.nc };
  const p = api.buildDensityProfile(params);
  assert.equal(p.effectiveRiseMode, 'exp');
  assert.equal(p.effectiveDecayMode, 'exp');
  assert.ok(Math.abs(p.alphaL) > 0.01 && Math.abs(p.alphaR) > 0.01);
  assert.equal(p.leftFactor, null);
  assert.equal(p.rightFactor, null);
  assert.equal(p.areaDimensionless, null);
  const expected = integrateRamp(api, params.leftStartDensitySI, 0, p.alphaL, 'exp', params.riseLength) +
    integrateRamp(api, 0, params.rightEndDensitySI, p.alphaR, 'exp', params.decayLength);
  near(p.arealDensitySI, expected, 2e-7);
});

test('equal nonzero endpoint densities produce the constant-density integral', () => {
  const api = loadPage(); const density = 5 * api.nc;
  for (const mode of ['nc', 'area']) {
    const params = { ...api.defaults, plateauDensitySI: density,
      leftStartDensitySI: density, rightEndDensitySI: density,
      riseExpMode: mode, decayExpMode: mode };
    const p = api.buildDensityProfile(params);
    near(p.arealDensitySI, density * (params.riseLength + params.plateauLength + params.decayLength) * 1e-6);
  }
});

test('nonzero results match pre-fix fixtures across ramp switches and constraints', () => {
  const api = loadPage();
  const fixtures = require('./nonzero-baseline.json');
  for (const { params, arealDensitySI } of fixtures) {
    near(api.buildDensityProfile({ ...api.defaults, ...params }).arealDensitySI, arealDensitySI);
  }
});

function npyValues(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = 10 + view.getUint16(8, true);
  return Array.from({ length: (bytes.length - offset) / 8 }, (_, i) => view.getFloat64(offset + 8 * i, true));
}

test('NPZ serializes correct zero and nonzero areal density, retaining missing-crossing sentinels', async () => {
  for (const [plateau, left, right] of [[0, 0, 0], [0, 2e27, 3e27], [1e28, 0, 0]]) {
    const api = loadPage();
    const params = { ...api.defaults, plateauDensitySI: plateau,
      leftStartDensitySI: left, rightEndDensitySI: right, riseMode: 'linear', decayMode: 'linear' };
    const profile = api.buildDensityProfile(params);
    api.setState(params); api.setProfile(profile);
    const files = new Map(); let downloaded = false;
    class Zip {
      file(name, data) { files.set(name, data); }
      async generateAsync() { return 'blob'; }
    }
    api.setExportHooks(Zip, () => {}, () => { downloaded = true; });
    await api.exportPlotDataNpZ();
    assert.equal(downloaded, true);
    near(npyValues(files.get('areal_density_m2.npy'))[0], profile.arealDensitySI);
    assert.ok(npyValues(files.get('ne_m3.npy')).every(Number.isFinite));
    if (!plateau && !left && !right) {
      assert.ok(npyValues(files.get('crossings_nc_um.npy')).every(Number.isNaN));
    }
  }
});

test('NPZ rejects invalid area, samples, edges and crossing coordinates before ZIP creation', async () => {
  const mutations = [
    (p) => { p.arealDensitySI = NaN; }, (p) => { p.arealDensitySI = Infinity; },
    (p) => { p.arealDensitySI = -1; }, (p) => { p.ySI[0] = NaN; },
    (p) => { p.x[0] = Infinity; }, (p) => { p.plateauEnd = NaN; },
    (p) => { p.crossings.leftActual = Infinity; }
  ];
  for (const mutate of mutations) {
    const api = loadPage(); const profile = api.buildDensityProfile(api.defaults);
    mutate(profile); api.setProfile(profile);
    let message = '';
    class Zip { constructor() { assert.fail('Invalid data reached ZIP creation'); } }
    api.setExportHooks(Zip, (text) => { message = text; }, () => assert.fail('Downloaded invalid data'));
    await api.exportPlotDataNpZ();
    assert.match(message, /invalid numeric/);
  }
});
