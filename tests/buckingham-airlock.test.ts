import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, createCustomScenario } from '../src/core/faultlineEngine.ts';
import {
  AirlockEgressBlockedError,
  assertZeroSensitiveEgress,
  buildBuckinghamAirlockPacket,
  canonicalizePiRatio,
} from '../src/core/buckinghamAirlock.ts';

test('Seam S4.1: canonicalizePiRatio eliminates IEEE-754 mantissa boundary flips across arbitrary positive lambdas', () => {
  const lambdas = [0.05, 0.3333333, 1, 7.3, 88.8, 1000, 99999.9];
  // 27 / 120 = 0.225 (notorious IEEE-754 float boundary under scaling)
  const ref = canonicalizePiRatio(27, 120);
  assert.equal(ref, 0.225);

  for (const lam of lambdas) {
    const scaled = canonicalizePiRatio(27 * lam, 120 * lam);
    assert.equal(
      scaled,
      ref,
      `Expected exact scale invariance at lambda=${lam}: got ${scaled} !== ${ref}`,
    );
  }
});

test('Seam S4.2: Outbound Buckingham-Pi JSON & SHA-256 receipt are 100% bit-identical under uniform dimensional scaling', async () => {
  const lambdas = [0.05, 1, 88.8, 1000];

  // Case A: Scenario 1 (typhoon-cpap) — scale all Wh and W quantities simultaneously
  const baseParams1 = {
    batteryWh: 1200,
    outageHours: 36,
    cpapWatts: 27, // 27 * 36 / 1200 = 0.81; also test 27/120 ratio via 7.5W * 36 / 1200 = 0.225!
    coolerWatts: 7.5,
    inverterTareW: 12.5,
  };
  const toggles1 = { disableHumidifier: false, dcDirectMode: true, preChillPacks: false };
  const refPkt1 = await buildBuckinghamAirlockPacket(SCENARIOS['typhoon-cpap'], baseParams1, toggles1);

  for (const lam of lambdas) {
    const scaledParams = {
      batteryWh: baseParams1.batteryWh * lam,
      outageHours: baseParams1.outageHours,
      cpapWatts: baseParams1.cpapWatts * lam,
      coolerWatts: baseParams1.coolerWatts * lam,
      inverterTareW: baseParams1.inverterTareW * lam,
    };
    const pkt = await buildBuckinghamAirlockPacket(SCENARIOS['typhoon-cpap'], scaledParams, toggles1);
    assert.equal(pkt.outboundJson, refPkt1.outboundJson, `Scenario 1 JSON differed at lambda=${lam}`);
    assert.equal(pkt.sha256Hex, refPkt1.sha256Hex, `Scenario 1 SHA-256 differed at lambda=${lam}`);
  }

  // Case B: Scenario 3 (expat-cashflow) — scale raw private JPY salary, vault, and rent by 100x
  const toggles3 = { fxForwardCap: true, rateCapClause: false, staggerMove: true };
  const baseCurrencyNote =
    'Employee: Kenji Sato (Passport JP-8831042) | Net Salary: ¥1,180,000/mo | Shinsei Vault Acct #0049-8829104: ¥12,980,000 | Rent: ¥495,600/mo';
  const baseParams3 = {
    reserveMonths: 11,
    housingRatioPct: 42,
    fxShockPct: 16,
    rateHikeBps: 225,
    relocOneOffMos: 3.5,
  };
  const refPkt3 = await buildBuckinghamAirlockPacket(SCENARIOS['expat-cashflow'], baseParams3, toggles3, {
    rawPrivateText: baseCurrencyNote,
    scaleCurrencyOverrides: true,
  });

  for (const lam of lambdas) {
    const scaledNote = `Employee: Kenji Sato (Passport JP-8831042) | Net Salary: ¥${(1180000 * lam).toFixed(2)}/mo | Shinsei Vault Acct #0049-8829104: ¥${(12980000 * lam).toFixed(2)} | Rent: ¥${(495600 * lam).toFixed(2)}/mo`;
    const pkt3 = await buildBuckinghamAirlockPacket(SCENARIOS['expat-cashflow'], baseParams3, toggles3, {
      rawPrivateText: scaledNote,
      scaleCurrencyOverrides: true,
    });
    assert.equal(pkt3.outboundJson, refPkt3.outboundJson, `Scenario 3 JSON differed at lambda=${lam}`);
    assert.equal(pkt3.sha256Hex, refPkt3.sha256Hex, `Scenario 3 SHA-256 differed at lambda=${lam}`);
  }
});

test('Seam S4.3: Closed-vocabulary payload contains zero user substrings and assertZeroSensitiveEgress fails closed on leaks', async () => {
  const custom = createCustomScenario({
    title: 'Project Chimera Rakuten Settlement Vault',
    archetype: 'peak_capacity',
    marginUnit: '% rail',
    horizonLabel: '12h Window',
    axisXUnit: 'h',
    safetyFloorPct: 20,
    capacityValue: 1800,
    capacityUnit: 'W',
    horizonValue: 12,
    rawPrivateSample:
      'Client: Dr. Mei-Ling Zhou | Card: 4532-0151-1283-0366 | DSN: postgres://admin_zhou@10.48.19.12:5432/chimera_prod | Token: sk_live_R9xQ7mK2vP8nL4wZ6jF1',
    loads: [
      {
        id: 'astronode',
        label: 'Astral150 Secret Laser Rig',
        value: 1400,
        unit: 'W',
        polarity: 'drain',
        window: { kind: 'always' },
      },
    ],
  });

  const pVals = Object.fromEntries(custom.params.map((p) => [p.key, p.value]));
  const pkt = await buildBuckinghamAirlockPacket(custom, pVals, {});

  // Verify L1, L1-Luhn, and L2 high-entropy detectors all caught sensitive items
  const categories = new Set(pkt.detectedSpans.map((s) => s.category));
  assert.ok(categories.has('PAYMENT_CARD_LUHN'), 'Must detect valid Luhn Mod-10 card');
  assert.ok(categories.has('DB_OR_RPC_DSN'), 'Must detect PostgreSQL DSN');
  assert.ok(categories.has('API_SECRET_TOKEN') || categories.has('HIGH_ENTROPY_SECRET'), 'Must detect secret token');

  // Verify outboundJson contains ZERO user domain nouns or PII substrings
  const forbidden = ['chimera', 'rakuten', 'zhou', '4532', '10.48.19.12', 'astral150', 'sk_live'];
  for (const word of forbidden) {
    assert.equal(
      pkt.outboundJson.toLowerCase().includes(word),
      false,
      `Outbound Buckingham-Pi JSON leaked forbidden user substring: ${word}`,
    );
  }

  // Valid outbound prompt passes firewall cleanly
  assert.doesNotThrow(() => {
    assertZeroSensitiveEgress(pkt.outboundJson, custom.rawPrivateSample, pkt.detectedSpans, true);
  });

  // Injecting any unredacted user word or PII immediately throws AirlockEgressBlockedError
  assert.throws(
    () => {
      assertZeroSensitiveEgress(
        `${pkt.outboundJson}\n# comment:chimera_prod`,
        custom.rawPrivateSample,
        pkt.detectedSpans,
        true,
      );
    },
    AirlockEgressBlockedError,
  );
});
