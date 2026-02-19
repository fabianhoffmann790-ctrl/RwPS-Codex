const STORAGE_KEY = 'rwps.line-settings.v1';

function createDefaultLineSettings(fillLines, bottleSizes, defaultFillRateByBottle) {
  return fillLines.reduce((acc, line) => {
    acc[line.id] = bottleSizes.reduce((lineAcc, bottleSize) => {
      lineAcc[bottleSize] = Number(defaultFillRateByBottle[bottleSize]);
      return lineAcc;
    }, {});
    return acc;
  }, {});
}

function sanitizeLineSettings(raw, fillLines, bottleSizes, defaultFillRateByBottle) {
  const defaults = createDefaultLineSettings(fillLines, bottleSizes, defaultFillRateByBottle);

  return fillLines.reduce((acc, line) => {
    acc[line.id] = bottleSizes.reduce((lineAcc, bottleSize) => {
      const parsed = Number(raw?.[line.id]?.[bottleSize]);
      lineAcc[bottleSize] = Number.isFinite(parsed) && parsed > 0 ? parsed : defaults[line.id][bottleSize];
      return lineAcc;
    }, {});
    return acc;
  }, {});
}

export function getLineSettings(fillLines, bottleSizes, defaultFillRateByBottle) {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return createDefaultLineSettings(fillLines, bottleSizes, defaultFillRateByBottle);
  }

  try {
    const parsed = JSON.parse(raw);
    return sanitizeLineSettings(parsed, fillLines, bottleSizes, defaultFillRateByBottle);
  } catch {
    return createDefaultLineSettings(fillLines, bottleSizes, defaultFillRateByBottle);
  }
}

export async function saveLineSettings(lineSettings, fillLines, bottleSizes, defaultFillRateByBottle) {
  const sanitized = sanitizeLineSettings(lineSettings, fillLines, bottleSizes, defaultFillRateByBottle);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  return sanitized;
}
