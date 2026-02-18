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
    };

    setOrders((prev) => [...prev, newOrder].sort((a, b) => a.start - b.start));
    setSelectedOrderId(newOrder.id);
    setForm((prev) => ({ ...prev, product: '', volumeLiters: '' }));
  };

  const assignOrderToMixer = () => {
    setError('');
    if (!selectedOrderId) {
      setError('Bitte zuerst einen offenen Abfüllauftrag auswählen.');
      return;
    }

    const order = orders.find((o) => o.id === selectedOrderId);
    if (!order || order.mixerId) {
      setError('Gewählter Auftrag ist nicht mehr offen.');
      return;
    }

    const mixerOrders = orders.filter((o) => o.mixerId === selectedMixerId);
    if (mixerOrders.some((existing) => overlaps(order, existing))) {
      setError('Zuweisung nicht möglich: Zeitblock überschneidet sich auf dem Rührwerk. Auftrag bleibt offen.');
      return;
    }

    setOrders((prev) =>
      prev.map((entry) => (entry.id === selectedOrderId ? { ...entry, mixerId: selectedMixerId } : entry))
    );
  };

  const rowsByLine = useMemo(
    () =>
      FILL_LINES.map((line) => ({
        ...line,
        orders: orders.filter((o) => o.lineId === line.id),
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
