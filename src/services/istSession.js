const ANCHOR_MINUTES = 6 * 60;

function toHHMM(totalMinutes) {
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const m = String(totalMinutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function toMinutes(value) {
  if (typeof value !== 'string' || !value.includes(':')) return NaN;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function calculateConflicts(session, mixerReservations = []) {
  const blocksByMixer = {};

  session.lines.forEach((line) => {
    line.positions.forEach((position) => {
      if (!position.mixerId) return;
      const mixerBlocks = blocksByMixer[position.mixerId] || [];
      mixerBlocks.push({
        mixerId: position.mixerId,
        blockId: `order-${position.orderId}`,
        start: toMinutes(position.startAt),
        end: toMinutes(position.endAt),
      });
      blocksByMixer[position.mixerId] = mixerBlocks;
    });
  });

  mixerReservations.forEach((reservation) => {
    if (!reservation.mixerId) return;
    const mixerBlocks = blocksByMixer[reservation.mixerId] || [];
    mixerBlocks.push({
      mixerId: reservation.mixerId,
      blockId: reservation.id || `res-${reservation.orderId}`,
      start: Number(reservation.start),
      end: Number(reservation.end),
    });
    blocksByMixer[reservation.mixerId] = mixerBlocks;
  });

  const conflicts = [];

  Object.values(blocksByMixer).forEach((blocks) => {
    const sorted = blocks
      .filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end > entry.start)
      .toSorted((a, b) => a.start - b.start || a.end - b.end);

    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      if (current.start < next.end && next.start < current.end) {
        conflicts.push({
          mixerId: current.mixerId,
          blockAId: current.blockId,
          blockBId: next.blockId,
          overlapStart: toHHMM(Math.max(current.start, next.start)),
          overlapEnd: toHHMM(Math.min(current.end, next.end)),
        });
      }
    }
  });

  return conflicts;
}

function toSessionLines(orders = []) {
  return [...new Set(orders.map((entry) => entry.lineId))].sort().map((lineId) => {
    const lineOrders = orders.filter((entry) => entry.lineId === lineId).toSorted((a, b) => a.start - b.start);
    return {
      lineId,
      positions: lineOrders.map((order, index) => ({
        position: index + 1,
        orderId: order.id,
        productionOrderNumber: order.productionOrderNumber,
        status: order.locked ? 'locked' : order.mixerId ? 'assigned' : 'unassigned',
        locked: Boolean(order.locked),
        startQty: Number(order.startQty ?? order.volumeLiters),
        restQty: Number(order.restQty ?? order.volumeLiters),
        startAt: toHHMM(order.start),
        endAt: toHHMM(order.end),
        durationMin: Math.max(1, order.end - order.start),
        mixerId: order.mixerId ?? null,
      })),
    };
  });
}

export function createIstSession({ date, orders, mixerReservations }) {
  const session = {
    sessionId: `ist-${date}`,
    version: 1,
    lines: toSessionLines(orders),
    dirty: false,
    history: [],
    hasConflicts: false,
    conflicts: [],
    canUpdatePlanner: false,
  };
  const conflicts = calculateConflicts(session, mixerReservations);
  session.hasConflicts = conflicts.length > 0;
  session.conflicts = conflicts;
  session.canUpdatePlanner = !session.hasConflicts && session.dirty;
  return session;
}

function recalculateFromPosition(line, changedIndex) {
  if (changedIndex < 0 || changedIndex >= line.positions.length) return;

  let cursor = ANCHOR_MINUTES;
  for (let index = changedIndex; index < line.positions.length; index += 1) {
    const current = line.positions[index];
    if (index === changedIndex) {
      current.startAt = toHHMM(cursor);
      current.endAt = toHHMM(cursor + current.durationMin);
      cursor += current.durationMin;
      continue;
    }

    current.startAt = toHHMM(cursor);
    current.endAt = toHHMM(cursor + current.durationMin);
    cursor += current.durationMin;
  }
}

function finalizeMutation(nextSession, mixerReservations) {
  nextSession.version += 1;
  const conflicts = calculateConflicts(nextSession, mixerReservations);
  nextSession.hasConflicts = conflicts.length > 0;
  nextSession.conflicts = conflicts;
  nextSession.canUpdatePlanner = !nextSession.hasConflicts && nextSession.dirty;

  return {
    ...nextSession,
    historyDepth: nextSession.history.length,
  };
}

function findLineAndPosition(session, orderId) {
  for (const line of session.lines) {
    const index = line.positions.findIndex((entry) => entry.orderId === orderId);
    if (index >= 0) {
      return { line, index };
    }
  }

  return { line: null, index: -1 };
}

function createVersionError() {
  const error = new Error('Version conflict');
  error.status = 409;
  return error;
}

export function saveRestQty(session, { orderId, restQty, expectedVersion, mixerReservations }) {
  if (expectedVersion !== session.version) throw createVersionError();

  const parsedRest = Number(restQty);
  if (!Number.isFinite(parsedRest) || parsedRest < 0) {
    const error = new Error('IST-VAL-001');
    error.status = 400;
    throw error;
  }

  const nextSession = clone(session);
  nextSession.history.push(clone(session));
  const { line, index } = findLineAndPosition(nextSession, orderId);
  if (!line) {
    const error = new Error('Auftrag nicht gefunden.');
    error.status = 404;
    throw error;
  }

  const target = line.positions[index];
  if (parsedRest > target.startQty) {
    const error = new Error('IST-VAL-002');
    error.status = 400;
    throw error;
  }

  if (parsedRest === 0) {
    line.positions.splice(index, 1);
    line.positions.forEach((entry, lineIndex) => {
      entry.position = lineIndex + 1;
    });
    if (line.positions[index]) {
      recalculateFromPosition(line, index);
    }
    nextSession.dirty = true;
    return finalizeMutation(nextSession, mixerReservations);
  }

  target.restQty = parsedRest;
  const durationNew = Math.max(1, Math.ceil(target.durationMin * (parsedRest / target.startQty)));
  target.durationMin = durationNew;
  recalculateFromPosition(line, index);
  nextSession.dirty = true;

  return finalizeMutation(nextSession, mixerReservations);
}

export function deleteOrder(session, { orderId, expectedVersion, mixerReservations }) {
  if (expectedVersion !== session.version) throw createVersionError();

  const nextSession = clone(session);
  nextSession.history.push(clone(session));
  const { line, index } = findLineAndPosition(nextSession, orderId);
  if (!line) {
    const error = new Error('Auftrag nicht gefunden.');
    error.status = 404;
    throw error;
  }

  line.positions.splice(index, 1);
  line.positions.forEach((entry, lineIndex) => {
    entry.position = lineIndex + 1;
  });

  if (line.positions[index]) {
    recalculateFromPosition(line, index);
  }

  nextSession.dirty = true;
  return finalizeMutation(nextSession, mixerReservations);
}

export function undo(session, { mixerReservations }) {
  if (session.history.length === 0) return session;

  const previous = clone(session.history[session.history.length - 1]);
  previous.history = session.history.slice(0, -1);
  const conflicts = calculateConflicts(previous, mixerReservations);
  previous.hasConflicts = conflicts.length > 0;
  previous.conflicts = conflicts;
  previous.canUpdatePlanner = !previous.hasConflicts && previous.dirty;
  return {
    ...previous,
    historyDepth: previous.history.length,
  };
}

export function publish(session, { expectedVersion }) {
  if (expectedVersion !== session.version) throw createVersionError();

  if (session.hasConflicts) {
    const error = new Error('IST-CONF-001');
    error.status = 422;
    throw error;
  }

  return {
    published: true,
    dirty: false,
    mainPlannerVersion: session.version + 1,
  };
}

export function convertSessionToOrders(session, orders) {
  const nextOrders = [];

  session.lines.forEach((line) => {
    line.positions.forEach((position) => {
      const source = orders.find((entry) => entry.id === position.orderId);
      if (!source) return;
      nextOrders.push({
        ...source,
        startQty: position.startQty,
        restQty: position.restQty,
        start: toMinutes(position.startAt),
        end: toMinutes(position.endAt),
      });
    });
  });

  return nextOrders.toSorted((a, b) => a.start - b.start);
}
