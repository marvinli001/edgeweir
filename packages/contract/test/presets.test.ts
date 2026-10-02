import { describe, expect, it } from "vitest";
import {
  CC_PRESETS,
  CC_TEMPLATE_DEFAULTS,
  CHALLENGE_PRESETS,
  ccThresholds,
  matchPreset,
  PRESET_LEVELS,
  siteProtectionUpdateInput,
  siteWafUpdateInput,
  WAF_DEFAULTS,
  WAF_PRESETS,
} from "../src/index";

const id = "00000000-0000-4000-8000-000000000000";

describe("protection presets", () => {
  it("make standard the defaults", () => {
    expect(CC_PRESETS.standard).toEqual(CC_TEMPLATE_DEFAULTS);
    expect(WAF_PRESETS.standard).toEqual({
      paranoiaLevel: WAF_DEFAULTS.paranoiaLevel,
      anomalyThreshold: WAF_DEFAULTS.anomalyThreshold,
      requestBodyLimit: WAF_DEFAULTS.requestBodyLimit,
    });
    expect(CHALLENGE_PRESETS.standard).toEqual({
      passTtlSeconds: 1800,
      powDifficulty: 16,
      powHighDifficulty: 20,
    });
  });

  it("are valid settings that grow stricter from loose to strict", () => {
    for (const level of PRESET_LEVELS) {
      expect(ccThresholds.parse(CC_PRESETS[level])).toEqual(CC_PRESETS[level]);
      expect(siteWafUpdateInput.parse({ id, ...WAF_PRESETS[level] })).toMatchObject(
        WAF_PRESETS[level],
      );
      const challenge = CHALLENGE_PRESETS[level];
      expect(siteProtectionUpdateInput.parse({ id, ...challenge })).toMatchObject(challenge);
      expect(challenge.powHighDifficulty).toBeGreaterThanOrEqual(challenge.powDifficulty);
    }
    const { loose, standard, strict } = CC_PRESETS;
    for (const key of ["siteQps", "urlQps", "ipQps", "escalateAfterSeconds"] as const) {
      expect(loose[key]).toBeGreaterThan(standard[key]);
      expect(standard[key]).toBeGreaterThan(strict[key]);
    }
    expect(loose.ipBanSeconds).toBeLessThan(strict.ipBanSeconds);
    expect(CHALLENGE_PRESETS.loose.powDifficulty).toBeLessThan(
      CHALLENGE_PRESETS.strict.powDifficulty,
    );
    expect(WAF_PRESETS.loose.anomalyThreshold).toBeGreaterThan(WAF_PRESETS.strict.anomalyThreshold);
  });

  it("match settings only when every value of a preset is equal", () => {
    expect(matchPreset(CC_PRESETS, { ...CC_PRESETS.strict })).toBe("strict");
    expect(matchPreset(CC_PRESETS, { ...CC_PRESETS.standard, urlQps: 201 })).toBeNull();
    expect(matchPreset(WAF_PRESETS, { ...WAF_PRESETS.loose })).toBe("loose");
    expect(
      matchPreset(CHALLENGE_PRESETS, {
        passTtlSeconds: 1800,
        powDifficulty: 16,
        powHighDifficulty: 22,
      }),
    ).toBeNull();
  });
});
