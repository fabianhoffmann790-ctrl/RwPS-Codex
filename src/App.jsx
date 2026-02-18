import { useMemo, useState } from 'react';

const FILL_LINES = [
  { id: 'L1', name: 'Abfülllinie 1' },
  { id: 'L2', name: 'Abfülllinie 2' },
  { id: 'L3', name: 'Abfülllinie 3' },
  { id: 'L4', name: 'Abfülllinie 4' },
];

const MIXERS = Array.from({ length: 10 }, (_, index) => ({
  id: `M${index + 1}`,
  name: `Rührwerk ${index + 1}`,
}));

const FILL_RATE_L_PER_MIN = 30;
const DAY_MINUTES = 24 * 60;

function toMinutes(timeHHMM) {
  const [hours, minutes] = timeHHMM.split(':').map(Number);
  return hours * 60 + minutes;
}

function toHHMM(totalMinutes) {
  const normalized = ((totalMinutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = String(Math.floor(normalized / 60)).padStart(2, '0');
  const m = String(normalized % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function timelinePosition(start, end) {
  const left = (start / DAY_MINUTES) * 100;
  const width = ((end - start) / DAY_MINUTES) * 100;
  return { left: `${left}%`, width: `${Math.max(width, 0.8)}%` };
}

function buildInitialDropState() {
  return MIXERS.reduce((acc, mixer) => {
    acc[mixer.id] = { isDropActive: false, isInvalid: false, dragDepth: 0 };
    return acc;
  }, {});
}

function reorderByIds(items, draggedId, targetId) {
  const fromIndex = items.findIndex((item) => item.id === draggedId);
  const toIndex = items.findIndex((item) => item.id === targetId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function App() {
  const [orders, setOrders] = useState([]);
  const [form, setForm] = useState({
    product: '',
    volumeLiters: '',
    lineId: FILL_LINES[0].id,
    startTime: '08:00',
  });
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [selectedMixerId, setSelectedMixerId] = useState(MIXERS[0].id);
  const [draggedOrderId, setDraggedOrderId] = useState(null);
  const [mixerDropState, setMixerDropState] = useState(buildInitialDropState);
  const [lineListDragState, setLineListDragState] = useState({ draggedOrderId: null, overOrderId: null });
  const [error, setError] = useState('');

  const openOrders = useMemo(() => orders.filter((o) => !o.mixerId), [orders]);

  const createOrder = (event) => {
    event.preventDefault();
    setError('');

    const volume = Number(form.volumeLiters);
    if (!form.product.trim()) {
      setError('Bitte Produktname eingeben.');
      return;
    }
    if (!Number.isFinite(volume) || volume <= 0) {
      setError('Bitte eine gültige Menge in Litern (>0) eingeben.');
      return;
    }

    const duration = Math.ceil(volume / FILL_RATE_L_PER_MIN);
    const start = toMinutes(form.startTime);
    const end = start + duration;

    if (end > DAY_MINUTES) {
      setError('Auftrag überschreitet den Tageszeitraum (00:00 - 24:00).');
      return;
    }

    const lineOrders = orders.filter((o) => o.lineId === form.lineId);
    const newSlot = { start, end };
    if (lineOrders.some((existing) => overlaps(newSlot, existing))) {
      setError('Zeitblock überschneidet sich auf der gewählten Abfülllinie.');
      return;
    }

    const newOrder = {
      id: crypto.randomUUID(),
      product: form.product.trim(),
      volumeLiters: volume,
      lineId: form.lineId,
      start,
      end,
      duration,
      mixerId: null,
      isLocked: false,
    };

    setOrders((prev) => [...prev, newOrder].sort((a, b) => a.start - b.start));
    setSelectedOrderId(newOrder.id);
    setForm((prev) => ({ ...prev, product: '', volumeLiters: '' }));
  };

  const tryAssignOrderToMixer = (orderId, mixerId) => {
    setError('');

    if (!orderId) {
      setError('Bitte zuerst einen offenen Abfüllauftrag auswählen.');
      return false;
    }

    const order = orders.find((o) => o.id === orderId);
    if (!order || order.mixerId) {
      setError('Gewählter Auftrag ist nicht mehr offen.');
      return false;
    }

    if (order.isLocked) {
      setError('Gesperrte Aufträge können nicht auf ein Rührwerk verschoben werden.');
      return false;
    }

    const mixerOrders = orders.filter((o) => o.mixerId === mixerId);
    if (mixerOrders.some((existing) => overlaps(order, existing))) {
      setError('Zuweisung nicht möglich: Zeitblock überschneidet sich auf dem Rührwerk. Auftrag bleibt offen.');
      return false;
    }

    setOrders((prev) =>
      prev.map((entry) => (entry.id === orderId ? { ...entry, mixerId } : entry))
    );
    return true;
  };

  const assignOrderToMixer = () => {
    tryAssignOrderToMixer(selectedOrderId, selectedMixerId);
  };

  const resetDragState = () => {
    setDraggedOrderId(null);
    setMixerDropState(buildInitialDropState());
  };

  const isMixerDropInvalid = (orderId, mixerId) => {
    if (!orderId) return false;
    const order = orders.find((entry) => entry.id === orderId);
    if (!order || order.mixerId) return false;

    const mixerOrders = orders.filter((entry) => entry.mixerId === mixerId);
    return mixerOrders.some((existing) => overlaps(order, existing));
  };

  const handleOrderDragStart = (event, orderId) => {
    const order = orders.find((entry) => entry.id === orderId);
    if (!order || order.isLocked) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.setData('text/order-id', orderId);
    setMixerDropState(buildInitialDropState());
    setDraggedOrderId(orderId);
  };

  const handleMixerDragEnter = (event, mixerId) => {
    event.preventDefault();
    setMixerDropState((prev) => {
      const current = prev[mixerId];
      const nextDepth = current.dragDepth + 1;
      return {
        ...prev,
        [mixerId]: {
          ...current,
          dragDepth: nextDepth,
          isDropActive: true,
          isInvalid: isMixerDropInvalid(draggedOrderId, mixerId),
        },
      };
    });
  };

  const handleMixerDragOver = (event, mixerId) => {
    event.preventDefault();
    setMixerDropState((prev) => {
      const current = prev[mixerId];
      const invalid = isMixerDropInvalid(draggedOrderId, mixerId);
      if (current.isDropActive && current.isInvalid === invalid) {
        return prev;
      }
      return {
        ...prev,
        [mixerId]: {
          ...current,
          isDropActive: true,
          isInvalid: invalid,
        },
      };
    });
  };

  const handleMixerDragLeave = (event, mixerId) => {
    event.preventDefault();
    setMixerDropState((prev) => {
      const current = prev[mixerId];
      const nextDepth = Math.max(0, current.dragDepth - 1);
      return {
        ...prev,
        [mixerId]: {
          ...current,
          dragDepth: nextDepth,
          isDropActive: nextDepth > 0,
          isInvalid: nextDepth > 0 ? current.isInvalid : false,
        },
      };
    });
  };

  const handleMixerDrop = (event, mixerId) => {
    event.preventDefault();
    const orderId = event.dataTransfer.getData('text/order-id') || draggedOrderId;
    tryAssignOrderToMixer(orderId, mixerId);
    resetDragState();
  };

  const handleLineListDragStart = (event, orderId) => {
    const order = orders.find((entry) => entry.id === orderId);
    if (!order || order.isLocked) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/order-id', orderId);
    setLineListDragState({ draggedOrderId: orderId, overOrderId: null });
    setError('');
  };

  const handleLineListDragOver = (event, overOrderId) => {
    event.preventDefault();
    setLineListDragState((prev) => (prev.overOrderId === overOrderId ? prev : { ...prev, overOrderId }));
  };

  const handleLineListDragEnd = () => {
    setLineListDragState({ draggedOrderId: null, overOrderId: null });
  };

  const handleLineListDrop = (event, lineId, targetOrderId) => {
    event.preventDefault();

    const draggedId = event.dataTransfer.getData('text/order-id') || lineListDragState.draggedOrderId;
    setLineListDragState({ draggedOrderId: null, overOrderId: null });

    if (!draggedId || !targetOrderId || draggedId === targetOrderId) return;

    setOrders((prev) => {
      const draggedOrder = prev.find((entry) => entry.id === draggedId);
      if (!draggedOrder || draggedOrder.lineId !== lineId || draggedOrder.isLocked) return prev;

      const targetOrder = prev.find((entry) => entry.id === targetOrderId);
      if (!targetOrder || targetOrder.isLocked) return prev;

      const lineOrders = prev.filter((entry) => entry.lineId === lineId).sort((a, b) => a.start - b.start);
      const reorderedLineOrders = reorderByIds(lineOrders, draggedId, targetOrderId);
      if (reorderedLineOrders === lineOrders) return prev;

      const anchorStart = lineOrders[0]?.start ?? 0;
      let cursor = anchorStart;
      const updatedLineOrders = reorderedLineOrders.map((entry) => {
        const start = cursor;
        const end = start + entry.duration;
        cursor = end;
        return { ...entry, start, end };
      });

      if (updatedLineOrders.some((entry) => entry.end > DAY_MINUTES)) {
        setError('Reihenfolgeänderung nicht möglich: Tageszeitraum 00:00–24:00 würde überschritten.');
        return prev;
      }

      const updatedById = new Map(updatedLineOrders.map((entry) => [entry.id, entry]));
      const nextOrders = prev.map((entry) => updatedById.get(entry.id) ?? entry);

      const hasMixerConflict = MIXERS.some((mixer) => {
        const mixerOrders = nextOrders
          .filter((entry) => entry.mixerId === mixer.id)
          .sort((a, b) => a.start - b.start);
        for (let i = 1; i < mixerOrders.length; i += 1) {
          if (overlaps(mixerOrders[i - 1], mixerOrders[i])) return true;
        }
        return false;
      });

      if (hasMixerConflict) {
        setError('Reihenfolgeänderung würde Überschneidungen auf einem Rührwerk verursachen und wurde verworfen.');
        return prev;
      }

      return nextOrders;
    });
  };

  const deleteOrder = (orderId) => {
    setOrders((prev) => prev.filter((entry) => entry.id !== orderId));
    setSelectedOrderId((prev) => (prev === orderId ? null : prev));
    setError('');
  };

  const unassignOrder = (orderId) => {
    const targetOrder = orders.find((entry) => entry.id === orderId);
    if (!targetOrder) return;
    if (targetOrder.isLocked) {
      setError('Gesperrte Aufträge können nicht vom Rührwerk gelöst werden.');
      return;
    }

    setOrders((prev) => prev.map((entry) => (entry.id === orderId ? { ...entry, mixerId: null } : entry)));
    setError('');
  };

  const toggleOrderLock = (orderId) => {
    setOrders((prev) =>
      prev.map((entry) => (entry.id === orderId ? { ...entry, isLocked: !entry.isLocked } : entry))
    );
    setError('');
  };

  const rowsByLine = useMemo(
    () =>
      FILL_LINES.map((line) => ({
        ...line,
        orders: orders.filter((o) => o.lineId === line.id).sort((a, b) => a.start - b.start),
      })),
    [orders]
  );

  const rowsByMixer = useMemo(
    () =>
      MIXERS.map((mixer) => ({
        ...mixer,
        orders: orders.filter((o) => o.mixerId === mixer.id),
      })),
    [orders]
  );

  return (
    <div className="page">
      <header>
        <h1>Planer für Abfülllinien & Rührwerke</h1>
        <p>Gantt-ähnliche manuelle Planung ohne Zeitblock-Überschneidungen.</p>
      </header>

      <section className="panel">
        <h2>Abfüllauftrag manuell anlegen</h2>
        <form className="form-grid" onSubmit={createOrder}>
          <label>
            Produkt
            <input
              value={form.product}
              onChange={(e) => setForm((prev) => ({ ...prev, product: e.target.value }))}
              placeholder="z. B. Shampoo A"
            />
          </label>
          <label>
            Menge (L)
            <input
              type="number"
              min="1"
              value={form.volumeLiters}
              onChange={(e) => setForm((prev) => ({ ...prev, volumeLiters: e.target.value }))}
              placeholder="z. B. 900"
            />
          </label>
          <label>
            Abfülllinie
            <select
              value={form.lineId}
              onChange={(e) => setForm((prev) => ({ ...prev, lineId: e.target.value }))}
            >
              {FILL_LINES.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Startzeit
            <input
              type="time"
              value={form.startTime}
              onChange={(e) => setForm((prev) => ({ ...prev, startTime: e.target.value }))}
            />
          </label>
          <button type="submit">Auftrag hinzufügen</button>
        </form>
        <p className="hint">Dauerberechnung: Menge (L) / 30 L/min (aufgerundet auf volle Minuten)</p>
      </section>

      <section className="panel">
        <h2>Auftragsliste je Abfülllinie (Drag & Drop Reihenfolge)</h2>
        <LineOrderLists
          rows={rowsByLine}
          dragState={lineListDragState}
          onDelete={deleteOrder}
          onUnassign={unassignOrder}
          onToggleLock={toggleOrderLock}
          onDragStart={handleLineListDragStart}
          onDragOver={handleLineListDragOver}
          onDrop={handleLineListDrop}
          onDragEnd={handleLineListDragEnd}
        />
      </section>

      <section className="panel">
        <h2>Offenen Abfüllauftrag einem Rührwerk zuweisen</h2>
        <div className="assign-row">
          <label>
            Offener Auftrag
            <select value={selectedOrderId ?? ''} onChange={(e) => setSelectedOrderId(e.target.value || null)}>
              <option value="">Bitte wählen</option>
              {openOrders.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.product} · {order.lineId} · {toHHMM(order.start)}-{toHHMM(order.end)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rührwerk
            <select value={selectedMixerId} onChange={(e) => setSelectedMixerId(e.target.value)}>
              {MIXERS.map((mixer) => (
                <option key={mixer.id} value={mixer.id}>
                  {mixer.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={assignOrderToMixer}>
            Zuweisen
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>Zeitstrahl Abfülllinien</h2>
        <Timeline rows={rowsByLine} onOrderDragStart={handleOrderDragStart} onOrderDragEnd={resetDragState} />
      </section>

      <section className="panel">
        <h2>Zeitstrahl Rührwerke (Echtzeit-Update bei Zuweisung)</h2>
        <Timeline
          rows={rowsByMixer}
          showUnassigned={false}
          onTrackDragEnter={handleMixerDragEnter}
          onTrackDragOver={handleMixerDragOver}
          onTrackDragLeave={handleMixerDragLeave}
          onTrackDrop={handleMixerDrop}
          trackState={mixerDropState}
        />
        <p className="hint">Drop nicht möglich bei Zeitüberschneidung.</p>
      </section>
    </div>
  );
}

function LineOrderLists({ rows, dragState, onDelete, onUnassign, onToggleLock, onDragStart, onDragOver, onDrop, onDragEnd }) {
  return (
    <div className="line-lists-grid">
      {rows.map((row) => (
        <article key={row.id} className="line-list-card">
          <h3>{row.name}</h3>
          {row.orders.length === 0 ? (
            <p className="hint">Keine Aufträge vorhanden.</p>
          ) : (
            <ul>
              {row.orders.map((order, index) => {
                const isTarget = dragState.overOrderId === order.id && dragState.draggedOrderId !== order.id;
                return (
                  <li
                    key={order.id}
                    className={`${isTarget ? 'drop-target' : ''} ${order.isLocked ? 'locked' : ''}`.trim()}
                    draggable={!order.isLocked}
                    onDragStart={(event) => onDragStart(event, order.id)}
                    onDragOver={(event) => onDragOver(event, order.id)}
                    onDrop={(event) => onDrop(event, row.id, order.id)}
                    onDragEnd={onDragEnd}
                  >
                    <span>
                      {index + 1}. {order.product}
                    </span>
                    <small>
                      {toHHMM(order.start)}-{toHHMM(order.end)} · {order.volumeLiters} L
                    </small>
                    <div className="order-actions">
                      <button type="button" title="Auftrag löschen" onClick={() => onDelete(order.id)}>
                        🗑️
                      </button>
                      <button
                        type="button"
                        title="Zuweisung lösen"
                        onClick={() => onUnassign(order.id)}
                        disabled={!order.mixerId || order.isLocked}
                      >
                        ⛓️‍💥
                      </button>
                      <button
                        type="button"
                        title={order.isLocked ? 'Auftrag entsperren' : 'Auftrag sperren'}
                        onClick={() => onToggleLock(order.id)}
                      >
                        {order.isLocked ? '🔒' : '🔓'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}

function Timeline({
  rows,
  showUnassigned = true,
  onOrderDragStart,
  onOrderDragEnd,
  onTrackDragEnter,
  onTrackDragOver,
  onTrackDragLeave,
  onTrackDrop,
  trackState = {},
}) {
  return (
    <div className="timeline-wrapper">
      <div className="timeline-scale">
        {['00:00', '06:00', '12:00', '18:00', '24:00'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      {rows.map((row) => {
        const state = trackState[row.id] ?? { isDropActive: false, isInvalid: false };
        const className = `timeline-track ${state.isDropActive ? 'drop-active' : ''} ${state.isDropActive && state.isInvalid ? 'drop-invalid' : ''}`.trim();

        return (
          <div className="timeline-row" key={row.id}>
            <div className="timeline-label">{row.name}</div>
            <div
              className={className}
              onDragEnter={onTrackDragEnter ? (event) => onTrackDragEnter(event, row.id) : undefined}
              onDragOver={onTrackDragOver ? (event) => onTrackDragOver(event, row.id) : undefined}
              onDragLeave={onTrackDragLeave ? (event) => onTrackDragLeave(event, row.id) : undefined}
              onDrop={onTrackDrop ? (event) => onTrackDrop(event, row.id) : undefined}
              title={state.isDropActive && state.isInvalid ? 'Drop nicht möglich bei Zeitüberschneidung' : undefined}
            >
              {row.orders.map((order) => (
                <div
                  key={order.id}
                  className={`block ${order.mixerId ? 'assigned' : 'open'}`}
                  style={timelinePosition(order.start, order.end)}
                  title={`${order.product}\n${toHHMM(order.start)} - ${toHHMM(order.end)}\n${order.volumeLiters} L`}
                  draggable={Boolean(onOrderDragStart) && !order.mixerId}
                  onDragStart={
                    onOrderDragStart && !order.mixerId ? (event) => onOrderDragStart(event, order.id) : undefined
                  }
                  onDragEnd={onOrderDragEnd}
                >
                  <span>{order.product}</span>
                  <small>
                    {toHHMM(order.start)}-{toHHMM(order.end)}
                  </small>
                  {showUnassigned && !order.mixerId ? <em>offen</em> : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default App;
