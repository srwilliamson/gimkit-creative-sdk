/**
 * Gimkit Creative properties only accept INTEGER default values (no decimals).
 * We store every weight/bias as an integer scaled by `valueScale` (default 100)
 * and the forward-pass block code works in fixed-point, dividing once at the
 * output layer. inputs stay 0/1; output1/output2/net_output store scaled ints.
 */

export function getValueScale(blueprint) {
  const s = Number(blueprint?.valueScale);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** Integer value to type into the Gimkit "Default Value" box for a property. */
export function scaledDefault(blueprint, name) {
  const raw = blueprint?.propertyDefaults?.[name] ?? 0;
  const scale = getValueScale(blueprint);
  return Math.round(raw * scale);
}

/** All scaled integer defaults keyed by property name. */
export function scaledDefaults(blueprint) {
  const out = {};
  for (const name of Object.keys(blueprint?.propertyDefaults || {})) {
    out[name] = scaledDefault(blueprint, name);
  }
  return out;
}

/**
 * Simulate the fixed-point forward pass exactly as the Gimkit blocks run it.
 * Mirrors RECIPES["forward-pass"] so we can verify XOR before touching the editor.
 */
export function fixedPointForward(input1, input2, blueprint) {
  const scale = getValueScale(blueprint);
  const w = scaledDefaults(blueprint);

  const z1 = w.bias1 + input1 * w["weight1-1"] + input2 * w["weight1-2"];
  const z2 = w.bias2 + input1 * w["weight2-1"] + input2 * w["weight2-2"];
  const h1 = Math.max(0, z1); // ReLU, still ×scale
  const h2 = Math.max(0, z2);

  // net (×scale) = bias3 + (h1*w31 + h2*w32)/scale
  const netScaled = Math.round(
    w.bias3 + (h1 * w["weight3-1"] + h2 * w["weight3-2"]) / scale,
  );

  return { z1, z2, output1: h1, output2: h2, net_output: netScaled };
}

/** XOR truth-table check using the fixed-point block math. */
export function evaluateXorFixedPoint(blueprint) {
  const scale = getValueScale(blueprint);
  const threshold = (blueprint?.architecture?.threshold ?? 0.5) * scale;
  const cases = [
    { in: [0, 0], target: 0 },
    { in: [0, 1], target: 1 },
    { in: [1, 0], target: 1 },
    { in: [1, 1], target: 0 },
  ];
  const rows = cases.map(({ in: inp, target }) => {
    const r = fixedPointForward(inp[0], inp[1], blueprint);
    const pred = r.net_output >= threshold ? 1 : 0;
    return {
      input1: inp[0],
      input2: inp[1],
      target,
      netScaled: r.net_output,
      netReal: r.net_output / scale,
      pred,
      correct: pred === target,
    };
  });
  const accuracy = rows.filter((r) => r.correct).length / rows.length;
  return { rows, accuracy, perfect: accuracy === 1, threshold, scale };
}
