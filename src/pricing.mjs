// Public reference API rates in USD per 1,000,000 tokens.
// Used strictly for local cost estimation & cache savings reference.
const MODEL_RATES = Object.freeze([
  { pattern: /opus/i, label: 'Claude Opus', input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  { pattern: /sonnet/i, label: 'Claude Sonnet', input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  { pattern: /haiku/i, label: 'Claude Haiku', input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  { pattern: /argon/i, label: 'Gemini Argon', input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 2.5 },
  { pattern: /carbon|pro/i, label: 'Gemini Pro / Carbon', input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  { pattern: /hydrogen|neon|flash/i, label: 'Gemini Flash / Hydrogen / Neon', input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
]);

export function lookupRates(modelName) {
  const name = String(modelName || '');
  if (!name) return null;
  for (const entry of MODEL_RATES) {
    if (entry.pattern.test(name)) return entry;
  }
  return null;
}

export function estimateCost({ model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  const rates = lookupRates(model);
  if (!rates) {
    return { priced: false, costUsd: 0, cacheSavedUsd: 0, rateLabel: null };
  }
  const safe = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  const inTok = safe(input);
  const outTok = safe(output);
  const crTok = safe(cacheRead);
  const cwTok = safe(cacheWrite);

  const costUsd =
    (inTok * rates.input + outTok * rates.output + crTok * rates.cacheRead + cwTok * rates.cacheWrite) / 1_000_000;
  const cacheSavedUsd = (crTok * Math.max(0, rates.input - rates.cacheRead)) / 1_000_000;

  return {
    priced: true,
    costUsd,
    cacheSavedUsd,
    rateLabel: rates.label,
  };
}

export function formatUsd(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(1)}`;
}
