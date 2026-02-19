import { useEffect, useMemo, useState } from 'react';
import { createProduct, deleteProduct, getProducts, updateProduct } from './services/products';

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
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const m = String(totalMinutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function createOrderBlock(order) {
  return {
    id: `order-${order.id}`,
    mixerId: order.mixerId,
    orderId: order.id,
    start: order.start,
    end: order.end,
    type: 'order',
  };
}

function findConflictingBlockIds(blocks) {
  const conflicts = new Set();
  const grouped = blocks.reduce((acc, block) => {
    if (!block.mixerId) return acc;
    if (!acc[block.mixerId]) acc[block.mixerId] = [];
    acc[block.mixerId].push(block);
    return acc;
  }, {});

  Object.values(grouped).forEach((mixerBlocks) => {
    const sorted = mixerBlocks.toSorted((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      if (overlaps(current, next)) {
        conflicts.add(current.id);
        conflicts.add(next.id);
      }
    }
  });

  return [...conflicts];
}

function App() {
  const [activeTab, setActiveTab] = useState('planung');
  const [products, setProducts] = useState([]);
  const [productError, setProductError] = useState('');
  const [editProductId, setEditProductId] = useState(null);

  const [productForm, setProductForm] = useState({ name: '', manufacturingDurationMin: '' });

  const [orders, setOrders] = useState([]);
  const [mixerReservations, setMixerReservations] = useState([]);
  const [conflictBlockIds, setConflictBlockIds] = useState([]);
  const [planError, setPlanError] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [selectedMixerId, setSelectedMixerId] = useState(MIXERS[0].id);
  const [orderForm, setOrderForm] = useState({
    productId: '',
    volumeLiters: '',
    lineId: FILL_LINES[0].id,
    startTime: '08:00',
  });

  const openOrders = useMemo(() => orders.filter((entry) => !entry.mixerId), [orders]);
  const timelineBlocks = useMemo(
    () => [
      ...mixerReservations,
      ...orders.filter((entry) => entry.mixerId).map((entry) => createOrderBlock(entry)),
    ],
    [mixerReservations, orders],
  );

  useEffect(() => {
    getProducts().then((loaded) => {
      setProducts(loaded);
      setOrderForm((prev) => ({ ...prev, productId: loaded[0]?.id ?? '' }));
    });
  }, []);

  const reloadProducts = async () => {
    const loaded = await getProducts();
    setProducts(loaded);
    setOrderForm((prev) => {
      if (loaded.some((entry) => entry.id === prev.productId)) return prev;
      return { ...prev, productId: loaded[0]?.id ?? '' };
    });
  };

  const onSubmitProduct = async (event) => {
    event.preventDefault();
    setProductError('');

    const duration = Number(productForm.manufacturingDurationMin);
    if (!productForm.name.trim()) {
      setProductError('Produktname ist erforderlich.');
      return;
    }
    if (!Number.isInteger(duration) || duration <= 0) {
      setProductError('Herstellungsdauer muss eine positive ganze Zahl sein.');
      return;
    }

    try {
      if (editProductId) {
        await updateProduct(editProductId, {
          name: productForm.name,
          manufacturingDurationMin: duration,
        });
      } else {
        await createProduct({ name: productForm.name, manufacturingDurationMin: duration });
      }
      setProductForm({ name: '', manufacturingDurationMin: '' });
      setEditProductId(null);
      await reloadProducts();
    } catch (error) {
      setProductError(error.message || 'Produkt konnte nicht gespeichert werden.');
    }
  };

  const startEdit = (product) => {
    setEditProductId(product.id);
    setProductForm({
      name: product.name,
      manufacturingDurationMin: String(product.manufacturingDurationMin),
    });
  };

  const removeProduct = async (id) => {
    const usedByOrder = orders.some((order) => order.productId === id);
    if (usedByOrder) {
      setProductError('Produkt kann nicht gelöscht werden, solange es in Aufträgen verwendet wird.');
      return;
    }

    await deleteProduct(id);
    await reloadProducts();
    setProductError('');
  };

  const createOrder = async (event) => {
    event.preventDefault();
    setPlanError('');

    const loadedProducts = await getProducts();
    const product = loadedProducts.find((entry) => entry.id === orderForm.productId);
    const volume = Number(orderForm.volumeLiters);

    if (!product) {
      setPlanError('Bitte zuerst ein Produkt in den Stammdaten anlegen.');
      return;
    }
    if (!Number.isInteger(product.manufacturingDurationMin) || product.manufacturingDurationMin <= 0) {
      setPlanError('Für das gewählte Produkt ist keine gültige Herstellungsdauer in den Stammdaten gepflegt.');
      return;
    }
    if (!Number.isFinite(volume) || volume <= 0) {
      setPlanError('Bitte eine gültige Menge in Litern (>0) eingeben.');
      return;
    }

    const fillDuration = Math.ceil(volume / FILL_RATE_L_PER_MIN);
    const manufacturingDuration = product.manufacturingDurationMin;
    const duration = Math.max(fillDuration, manufacturingDuration);
    const start = toMinutes(orderForm.startTime);
    const end = start + duration;

    if (end > DAY_MINUTES) {
      setPlanError('Auftrag überschreitet den Tageszeitraum (00:00 - 24:00).');
      return;
    }

    const lineOrders = orders.filter((entry) => entry.lineId === orderForm.lineId);
    if (lineOrders.some((entry) => overlaps({ start, end }, entry))) {
      setPlanError('Zeitblock überschneidet sich auf der gewählten Abfülllinie.');
      return;
    }

    const newOrder = {
      id: crypto.randomUUID(),
      productId: product.id,
      productName: product.name,
      volumeLiters: volume,
      fillDuration,
      manufacturingDuration,
      lineId: orderForm.lineId,
      start,
      end,
      mixerId: null,
    };

    setOrders((prev) => [...prev, newOrder].sort((a, b) => a.start - b.start));
    setOrderForm((prev) => ({ ...prev, volumeLiters: '' }));
    setSelectedOrderId(newOrder.id);
  };

  const tryAssignOrderToMixer = () => {
    setPlanError('');
    setConflictBlockIds([]);
    if (!selectedOrderId) {
      setPlanError('Bitte offenen Auftrag wählen.');
      return;
    }

    const order = orders.find((entry) => entry.id === selectedOrderId);
    if (!order || order.mixerId) {
      setPlanError('Gewählter Auftrag ist nicht mehr offen.');
      return;
    }

    const manufacturingBlock = {
      id: crypto.randomUUID(),
      mixerId: selectedMixerId,
      orderId: order.id,
      start: order.start - order.manufacturingDuration,
      end: order.start,
      type: 'manufacturing',
    };

    if (manufacturingBlock.start < 0) {
      setPlanError('Zuweisung nicht möglich: Herstellungszeitraum liegt vor 00:00 Uhr.');
      return;
    }

    const mixerBlocks = timelineBlocks.filter((entry) => entry.mixerId === selectedMixerId);
    if (mixerBlocks.some((entry) => overlaps(manufacturingBlock, entry))) {
      setPlanError('Zuweisung nicht möglich: Herstellungsblock kollidiert mit vorhandener Rührwerks-Reservierung.');
      return;
    }

    setOrders((prev) => prev.map((entry) => (entry.id === selectedOrderId ? { ...entry, mixerId: selectedMixerId } : entry)));
    setMixerReservations((prev) => [...prev, manufacturingBlock]);
    setSelectedOrderId('');
  };

  const unassignOrderFromMixer = (orderId) => {
    setConflictBlockIds([]);
    setOrders((prev) => prev.map((entry) => (entry.id === orderId ? { ...entry, mixerId: null } : entry)));
    setMixerReservations((prev) => prev.filter((entry) => entry.orderId !== orderId));
  };

  const removeOrder = (orderId) => {
    setConflictBlockIds([]);
    setOrders((prev) => prev.filter((entry) => entry.id !== orderId));
    setMixerReservations((prev) => prev.filter((entry) => entry.orderId !== orderId));
    if (selectedOrderId === orderId) {
      setSelectedOrderId('');
    }
  };

  const handleLineListDrop = (lineId, movedOrderId, targetOrderId) => {
    setPlanError('');
    setConflictBlockIds([]);

    setOrders((prevOrders) => {
      const lineOrders = prevOrders.filter((entry) => entry.lineId === lineId).toSorted((a, b) => a.start - b.start);
      const fromIndex = lineOrders.findIndex((entry) => entry.id === movedOrderId);
      const toIndex = lineOrders.findIndex((entry) => entry.id === targetOrderId);

      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return prevOrders;
      }

      const reorderedLineOrders = [...lineOrders];
      const [movedOrder] = reorderedLineOrders.splice(fromIndex, 1);
      reorderedLineOrders.splice(toIndex, 0, movedOrder);

      const initialStart = lineOrders[0]?.start ?? 0;
      let cursor = initialStart;
      const recalculatedById = new Map();

      reorderedLineOrders.forEach((entry) => {
        const duration = entry.end - entry.start;
        const recalculated = { ...entry, start: cursor, end: cursor + duration };
        recalculatedById.set(entry.id, recalculated);
        cursor = recalculated.end;
      });

      const nextOrders = prevOrders
        .map((entry) => recalculatedById.get(entry.id) ?? entry)
        .toSorted((a, b) => a.start - b.start);

      const nextReservations = mixerReservations.map((reservation) => {
        const order = recalculatedById.get(reservation.orderId);
        if (!order || reservation.type !== 'manufacturing') return reservation;
        return {
          ...reservation,
          start: order.start - order.manufacturingDuration,
          end: order.start,
        };
      });

      if (nextReservations.some((entry) => entry.start < 0)) {
        setPlanError('Reihenfolge nicht möglich: Mindestens ein Herstellungsblock würde vor 00:00 Uhr liegen.');
        return prevOrders;
      }

      const allBlocks = [...nextReservations, ...nextOrders.filter((entry) => entry.mixerId).map((entry) => createOrderBlock(entry))];
      const conflicts = findConflictingBlockIds(allBlocks);
      if (conflicts.length > 0) {
        setPlanError('Reihenfolge zurückgesetzt: Herstellungsblock-Kollision mit bestehender Rührwerks-Reservierung erkannt.');
        setConflictBlockIds(conflicts);
        return prevOrders;
      }

      setMixerReservations(nextReservations);
      return nextOrders;
    });
  };

  const lineOrdersById = useMemo(
    () =>
      orders.reduce((acc, order) => {
        if (!acc[order.lineId]) acc[order.lineId] = [];
        acc[order.lineId].push(order);
        return acc;
      }, {}),
    [orders],
  );

  return (
    <div className="page">
      <header>
        <h1>RwPS Produktionsplaner</h1>
      </header>

      <nav className="tabs panel">
        <button
          type="button"
          className={activeTab === 'planung' ? 'tab-active' : ''}
          onClick={() => setActiveTab('planung')}
        >
          Planung
        </button>
        <button
          type="button"
          className={activeTab === 'stammdaten' ? 'tab-active' : ''}
          onClick={() => setActiveTab('stammdaten')}
        >
          Stammdaten
        </button>
      </nav>

      {activeTab === 'planung' ? (
        <>
          <section className="panel">
            <h2>Abfüllauftrag erfassen</h2>
            <form className="form-grid" onSubmit={createOrder}>
              <label>
                Produkt
                <select
                  value={orderForm.productId}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, productId: e.target.value }))}
                  disabled={products.length === 0}
                >
                  {products.length === 0 ? <option value="">Keine Produkte vorhanden</option> : null}
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Menge (L)
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={orderForm.volumeLiters}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, volumeLiters: e.target.value }))}
                />
              </label>
              <label>
                Abfülllinie
                <select
                  value={orderForm.lineId}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, lineId: e.target.value }))}
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
                  value={orderForm.startTime}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, startTime: e.target.value }))}
                />
              </label>
              <button type="submit" disabled={products.length === 0}>
                Auftrag hinzufügen
              </button>
            </form>
            <p>
              Hinweis: Die Abfüllzeit wird aus Menge / {FILL_RATE_L_PER_MIN} L/min berechnet. Die
              Herstellungsdauer kommt aus den Produkt-Stammdaten. Für die Planung zählt jeweils der längere
              Wert.
            </p>
            {planError && <p className="error">{planError}</p>}
          </section>

          <section className="panel">
            <h2>Offenen Auftrag einem Rührwerk zuweisen</h2>
            <div className="assign-row">
              <label>
                Offener Auftrag
                <select value={selectedOrderId} onChange={(e) => setSelectedOrderId(e.target.value)}>
                  <option value="">Bitte wählen</option>
                  {openOrders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.productName} · {order.lineId} · {toHHMM(order.start)}-{toHHMM(order.end)}
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
              <button type="button" onClick={tryAssignOrderToMixer}>
                Zuweisen
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>Zeitstrahl</h2>
            <div className="timeline-grid">
              {MIXERS.map((mixer) => (
                <div key={mixer.id} className="timeline-row">
                  <div className="timeline-label">{mixer.name}</div>
                  <div className="timeline-track">
                    {timelineBlocks
                      .filter((reservation) => reservation.mixerId === mixer.id)
                      .map((reservation) => (
                        <div
                          key={reservation.id}
                          className={`block ${reservation.type} ${conflictBlockIds.includes(reservation.id) ? 'conflict' : ''}`}
                          style={{
                            left: `${(reservation.start / DAY_MINUTES) * 100}%`,
                            width: `${((reservation.end - reservation.start) / DAY_MINUTES) * 100}%`,
                          }}
                          title={`Auftrag ${reservation.orderId} · ${toHHMM(reservation.start)}-${toHHMM(reservation.end)}`}
                        >
                          {reservation.type === 'manufacturing' ? 'H' : 'A'}
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Aufträge</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Menge</th>
                  <th>Linie</th>
                  <th>Abfüllzeit</th>
                  <th>Herstellungsdauer</th>
                  <th>Zeitraum</th>
                  <th>Rührwerk</th>
                  <th>Reihenfolge</th>
                  <th>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const lineOrders = lineOrdersById[order.lineId]?.toSorted((a, b) => a.start - b.start) ?? [];
                  const currentIndex = lineOrders.findIndex((entry) => entry.id === order.id);
                  const previousOrder = currentIndex > 0 ? lineOrders[currentIndex - 1] : null;
                  const nextOrder = currentIndex < lineOrders.length - 1 ? lineOrders[currentIndex + 1] : null;

                  return (
                    <tr key={order.id}>
                    <td>{order.productName}</td>
                    <td>{order.volumeLiters} L</td>
                    <td>{order.lineId}</td>
                    <td>{order.fillDuration} min</td>
                    <td>{order.manufacturingDuration} min</td>
                    <td>
                      {toHHMM(order.start)}-{toHHMM(order.end)}
                    </td>
                    <td>{order.mixerId ?? 'offen'}</td>
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="secondary"
                          disabled={!previousOrder}
                          onClick={() => previousOrder && handleLineListDrop(order.lineId, order.id, previousOrder.id)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={!nextOrder}
                          onClick={() => nextOrder && handleLineListDrop(order.lineId, order.id, nextOrder.id)}
                        >
                          ↓
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="actions">
                        {order.mixerId ? (
                          <button type="button" className="secondary" onClick={() => unassignOrderFromMixer(order.id)}>
                            Entkoppeln
                          </button>
                        ) : null}
                        <button type="button" className="danger" onClick={() => removeOrder(order.id)}>
                          Löschen
                        </button>
                      </div>
                    </td>
                    </tr>
                  );
                })}
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan="9">Noch keine Aufträge vorhanden.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <section className="panel">
          <h2>Stammdaten: Produkte</h2>
          <form className="form-grid" onSubmit={onSubmitProduct}>
            <label>
              Name (eindeutig)
              <input
                value={productForm.name}
                onChange={(e) => setProductForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="z. B. Isodrink Orange"
              />
            </label>
            <label>
              Herstellungsdauer (Min)
              <input
                type="number"
                min="1"
                step="1"
                value={productForm.manufacturingDurationMin}
                onChange={(e) =>
                  setProductForm((prev) => ({ ...prev, manufacturingDurationMin: e.target.value }))
                }
              />
            </label>
            <button type="submit">{editProductId ? 'Produkt aktualisieren' : 'Produkt anlegen'}</button>
            {editProductId ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditProductId(null);
                  setProductForm({ name: '', manufacturingDurationMin: '' });
                  setProductError('');
                }}
              >
                Abbrechen
              </button>
            ) : null}
          </form>
          {productError && <p className="error">{productError}</p>}

          <table className="data-table top-space">
            <thead>
              <tr>
                <th>Name</th>
                <th>Herstellungsdauer</th>
                <th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>{product.name}</td>
                  <td>{product.manufacturingDurationMin} min</td>
                  <td>
                    <div className="actions">
                      <button type="button" onClick={() => startEdit(product)}>
                        Bearbeiten
                      </button>
                      <button type="button" className="danger" onClick={() => removeProduct(product.id)}>
                        Löschen
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export default App;
