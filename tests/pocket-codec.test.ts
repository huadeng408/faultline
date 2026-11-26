import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../src/core/faultlineEngine.ts';
import { encodePocketUrl, decodePocketUrl } from '../src/core/pocketCodec.ts';

test('Seam S5.1: Pocket codec produces valid <320-char https:// URL and round-trips state losslessly', () => {
  const sc = SCENARIOS['expat-cashflow'];
  const params = {
    reserveMonths: 13,
    housingRatioPct: 39,
    fxShockPct: 18,
    rateHikeBps: 250,
    relocOneOffMos: 3.0,
  };
  const toggles = {
    fxForwardCap: true,
    rateCapClause: false,
    staggerMove: true,
  };

  const url = encodePocketUrl('https://faultline-v3.web.app', {
    scenarioId: sc.id,
    paramValues: params,
    toggleValues: toggles,
    verifiedMargin: 2.4,
    isSafe: true,
  });

  assert.ok(url.startsWith('https://faultline-v3.web.app/?pocket='), `Unexpected URL prefix: ${url}`);
  assert.ok(url.length < 320, `Expected compact QR URL < 320 chars, got ${url.length}: ${url}`);

  const decoded = decodePocketUrl(url);
  assert.ok(decoded, 'Expected non-null decoded pocket state');
  assert.equal(decoded.scenarioId, 'expat-cashflow');
  assert.deepEqual(decoded.paramValues, params);
  assert.deepEqual(decoded.toggleValues, toggles);
  assert.equal(decoded.verifiedMargin, 2.4);
  assert.equal(decoded.isSafe, true);
});
