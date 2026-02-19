export const LINE_SETTINGS_STORAGE_KEY = 'rwps.line-settings.v1';

export function createDefaultLineSettings(fillLines, bottleSizes, defaultFillRateByBottle) {
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

function persistLineSettings(lineSettings) {
  localStorage.setItem(LINE_SETTINGS_STORAGE_KEY, JSON.stringify(lineSettings));
}

export function getLineSettings(fillLines, bottleSizes, defaultFillRateByBottle) {
  const defaults = createDefaultLineSettings(fillLines, bottleSizes, defaultFillRateByBottle);
  const raw = localStorage.getItem(LINE_SETTINGS_STORAGE_KEY);
  if (!raw) {
    persistLineSettings(defaults);
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw);
    const sanitized = sanitizeLineSettings(parsed, fillLines, bottleSizes, defaultFillRateByBottle);
    if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
      persistLineSettings(sanitized);
    }
    return sanitized;
  } catch {
    persistLineSettings(defaults);
    return defaults;
  }
}

export async function saveLineSettings(lineSettings, fillLines, bottleSizes, defaultFillRateByBottle) {
  const sanitized = sanitizeLineSettings(lineSettings, fillLines, bottleSizes, defaultFillRateByBottle);
  persistLineSettings(sanitized);
  return sanitized;
}
