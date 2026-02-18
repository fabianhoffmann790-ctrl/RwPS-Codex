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

function sortByLinePosition(a, b) {
  if (a.linePosition !== b.linePosition) {
    return a.linePosition - b.linePosition;
  }
  return a.start - b.start;
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
  const [draggedOrder, setDraggedOrder] = useState(null);
  const [activeLineDropTarget, setActiveLineDropTarget] = useState(null);
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

    const nextPosition = lineOrders.length ? Math.max(...lineOrders.map((order) => order.linePosition)) + 1 : 0;

    const newOrder = {
      id: crypto.randomUUID(),
      product: form.product.trim(),
      volumeLiters: volume,
      lineId: form.lineId,
      start,
      end,
      duration,
      linePosition: nextPosition,
      mixerId: null,
    };

    setOrders((prev) => [...prev, newOrder]);
    setSelectedOrderId(newOrder.id);
    setForm((prev) => ({ ...prev, product: '', volumeLiters: '' }));
  };

  const tryAssignOrderToMixer = (orderId, mixerId) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order || order.mixerId) {
      setError('Gewählter Auftrag ist nicht mehr offen.');
      return;
    }

    const mixerOrders = orders.filter((o) => o.mixerId === mixerId);
    if (mixerOrders.some((existing) => overlaps(order, existing))) {
      setError('Zuweisung nicht möglich: Zeitblock überschneidet sich auf dem Rührwerk. Auftrag bleibt offen.');
      return;
    }

    setOrders((prev) => prev.map((entry) => (entry.id === orderId ? { ...entry, mixerId } : entry)));
  };

  const assignOrderToMixer = () => {
    setError('');
    if (!selectedOrderId) {
      setError('Bitte zuerst einen offenen Abfüllauftrag auswählen.');
      return;
    }

    tryAssignOrderToMixer(selectedOrderId, selectedMixerId);
  };

  const reorderLineOrders = (lineId, draggedId, targetId) => {
    setError('');
    setActiveLineDropTarget(null);

    setOrders((prev) => {
      const lineOrders = prev.filter((o) => o.lineId === lineId).sort(sortByLinePosition);
      const draggedIndex = lineOrders.findIndex((o) => o.id === draggedId);
      if (draggedIndex === -1) {
        return prev;
      }

      const reordered = [...lineOrders];
      const [draggedItem] = reordered.splice(draggedIndex, 1);

      if (!targetId) {
        reordered.push(draggedItem);
      } else {
        const targetIndex = reordered.findIndex((o) => o.id === targetId);
        if (targetIndex === -1) {
          reordered.push(draggedItem);
        } else {
          reordered.splice(targetIndex, 0, draggedItem);
        }
      }

      const baseStart = lineOrders.length ? Math.min(...lineOrders.map((o) => o.start)) : 0;
      let cursor = baseStart;
      const updatedById = new Map();

      for (let index = 0; index < reordered.length; index += 1) {
        const order = reordered[index];
        const start = cursor;
        const end = start + order.duration;

        if (end > DAY_MINUTES) {
          setError('Reihenfolge kann nicht gesetzt werden: Tageszeitraum (00:00-24:00) würde überschritten.');
          return prev;
        }

        cursor = end;
        updatedById.set(order.id, {
          ...order,
          start,
          end,
          linePosition: index,
        });
      }

      const changedIds = new Set(updatedById.keys());
      const nextOrders = prev.map((order) => updatedById.get(order.id) ?? order);

      const mixerConflictIds = new Set();
      for (const order of nextOrders) {
        if (!changedIds.has(order.id) || !order.mixerId) {
          continue;
        }

        const hasConflict = nextOrders.some(
          (other) => other.id !== order.id && other.mixerId === order.mixerId && overlaps(order, other)
        );

        if (hasConflict) {
          mixerConflictIds.add(order.id);
        }
      }

      if (mixerConflictIds.size > 0) {
        setError(
          'Hinweis: Einige Rührwerkszuweisungen wurden entfernt, weil die neue Reihenfolge Zeitüberschneidungen erzeugt hat.'
        );
      }

      return nextOrders.map((order) =>
        mixerConflictIds.has(order.id)
          ? {
              ...order,
              mixerId: null,
            }
          : order
      );
    });
  };

  const rowsByLine = useMemo(
    () =>
      FILL_LINES.map((line) => ({
        ...line,
        orders: orders.filter((o) => o.lineId === line.id).sort(sortByLinePosition),
      })),
    [orders]
  );

  const rowsByMixer = useMemo(
    () =>
      MIXERS.map((mixer) => ({
        ...mixer,
        orders: orders.filter((o) => o.mixerId === mixer.id).sort((a, b) => a.start - b.start),
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
        <h2>Auftragslisten je Abfülllinie (Drag & Drop Reihenfolge)</h2>
        <div className="line-lists">
          {rowsByLine.map((line) => (
            <div className="line-list-card" key={line.id}>
              <h3>{line.name}</h3>
              <ul>
                {line.orders.map((order) => (
                  <li
                    key={order.id}
                    className={`line-order-item ${
                      activeLineDropTarget?.lineId === line.id && activeLineDropTarget?.targetId === order.id
                        ? 'drop-target-active'
                        : ''
                    }`}
                    draggable
                    onDragStart={() => {
                      setError('');
                      setDraggedOrder({ lineId: line.id, orderId: order.id });
                    }}
                    onDragEnd={() => {
                      setDraggedOrder(null);
                      setActiveLineDropTarget(null);
                    }}
                    onDragOver={(event) => {
                      if (draggedOrder?.lineId === line.id) {
                        event.preventDefault();
                        setActiveLineDropTarget({ lineId: line.id, targetId: order.id });
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedOrder?.lineId !== line.id) {
                        return;
                      }
                      reorderLineOrders(line.id, draggedOrder.orderId, order.id);
                      setDraggedOrder(null);
                    }}
                  >
                    <span>
                      {order.product} · {order.volumeLiters} L
                    </span>
                    <small>
                      {toHHMM(order.start)}-{toHHMM(order.end)}
                    </small>
                  </li>
                ))}
                {line.orders.length > 0 ? (
                  <li
                    className={`line-order-drop-end ${
                      activeLineDropTarget?.lineId === line.id && activeLineDropTarget?.targetId === null
                        ? 'drop-target-active'
                        : ''
                    }`}
                    onDragOver={(event) => {
                      if (draggedOrder?.lineId === line.id) {
                        event.preventDefault();
                    setActiveLineDropTarget({ lineId: line.id, targetId: null });
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedOrder?.lineId !== line.id) {
                        return;
                      }
                      reorderLineOrders(line.id, draggedOrder.orderId, null);
                      setDraggedOrder(null);
                    }}
                  >
                    Hier ablegen, um ans Ende zu verschieben
                  </li>
                ) : (
                  <li className="line-order-empty">Keine Aufträge</li>
                )}
              </ul>
            </div>
          ))}
        </div>
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
        <Timeline rows={rowsByLine} />
      </section>

      <section className="panel">
        <h2>Zeitstrahl Rührwerke (Echtzeit-Update bei Zuweisung)</h2>
        <Timeline rows={rowsByMixer} showUnassigned={false} />
      </section>
    </div>
  );
}

function Timeline({ rows, showUnassigned = true }) {
  return (
    <div className="timeline-wrapper">
      <div className="timeline-scale">
        {['00:00', '06:00', '12:00', '18:00', '24:00'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      {rows.map((row) => (
        <div className="timeline-row" key={row.id}>
          <div className="timeline-label">{row.name}</div>
          <div className="timeline-track">
            {row.orders.map((order) => (
              <div
                key={order.id}
                className={`block ${order.mixerId ? 'assigned' : 'open'}`}
                style={timelinePosition(order.start, order.end)}
                title={`${order.product}\n${toHHMM(order.start)} - ${toHHMM(order.end)}\n${order.volumeLiters} L`}
              >
                <span>{order.product}</span>
                <small>{toHHMM(order.start)}-{toHHMM(order.end)}</small>
                {showUnassigned && !order.mixerId ? <em>offen</em> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default App;
