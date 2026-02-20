import { useEffect, useMemo, useState } from 'react';
import { createProduct, deleteProduct, getProducts, updateProduct } from './services/products';
import { createDefaultLineSettings, getLineSettings, saveLineSettings } from './services/lineSettings';
import {
  convertSessionToOrders,
  createIstSession,
  deleteOrder as deleteIstOrder,
  publish as publishIst,
  saveRestQty,
  undo as undoIst,
} from './services/istSession';

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

const BOTTLE_SIZES = ['0.25L', '0.5L', '1L', '5L'];
const BOTTLE_SIZE_LABELS = {
  '0.25L': '0,25L',
  '0.5L': '0,5L',
  '1L': '1L',
  '5L': '5L',
};
const DEFAULT_FILL_RATE_BY_BOTTLE = {
  '0.25L': 12,
  '0.5L': 15,
  '1L': 30,
  '5L': 45,
};
const SCHEDULE_STORAGE_KEY = 'rwps.schedule.v1';
const DAY_MINUTES = 24 * 60;
const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_MAX = 4;
const TIMELINE_ZOOM_STEP = 0.25;
const TIMELINE_SCALE_TICK_MINUTES = 120;

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

function getOrderStatus(order) {
  if (order.locked) return 'locked';
  if (order.mixerId) return 'assigned';
  return 'unassigned';
}

function createOrderBlock(order) {
  return {
    id: `order-${order.id}`,
    mixerId: order.mixerId,
    orderId: order.id,
    start: order.start,
    end: order.end,
    type: 'order',
    status: getOrderStatus(order),
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

function normalizeLineSettingsValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
}

function normalizeOrderOnLoad(rawOrder, lineSettings) {
  if (!rawOrder || typeof rawOrder !== 'object') return null;

  const volumeLiters = Number(rawOrder.volumeLiters);
  const start = Number(rawOrder.start);
  const end = Number(rawOrder.end);
  const manufacturingDuration = Number(rawOrder.manufacturingDuration);

  if (!Number.isFinite(volumeLiters) || volumeLiters <= 0) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (!Number.isInteger(manufacturingDuration) || manufacturingDuration <= 0) return null;

  const lineId = FILL_LINES.some((line) => line.id === rawOrder.lineId) ? rawOrder.lineId : FILL_LINES[0].id;
  const bottleSize = BOTTLE_SIZES.includes(rawOrder.bottleSize) ? rawOrder.bottleSize : '1L';
  const fillRate = Number(lineSettings?.[lineId]?.[bottleSize]);
  const fallbackRate = Number(DEFAULT_FILL_RATE_BY_BOTTLE[bottleSize]);
  const effectiveRate = Number.isFinite(fillRate) && fillRate > 0 ? fillRate : fallbackRate;

  const loadedFillDuration = Number(rawOrder.fillDuration);
  const fillDuration =
    Number.isInteger(loadedFillDuration) && loadedFillDuration > 0
      ? loadedFillDuration
      : Math.max(1, Math.ceil(volumeLiters / effectiveRate));

  return {
    ...rawOrder,
    id: rawOrder.id || crypto.randomUUID(),
    lineId,
    bottleSize,
    fillDuration,
    volumeLiters,
    start,
    end,
  };
}

function App() {
  const [activeTab, setActiveTab] = useState('planung');
  const [products, setProducts] = useState([]);
  const [productError, setProductError] = useState('');
  const [editProductId, setEditProductId] = useState(null);

  const [productForm, setProductForm] = useState({ name: '', articleNumber: '', manufacturingDurationMin: '' });

  const [orders, setOrders] = useState([]);
  const [mixerReservations, setMixerReservations] = useState([]);
  const [conflictBlockIds, setConflictBlockIds] = useState([]);
  const [planError, setPlanError] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [selectedMixerId, setSelectedMixerId] = useState(MIXERS[0].id);
  const [orderForm, setOrderForm] = useState({
    productId: '',
    volumeLiters: '',
    bottleSize: '1L',
    productionOrderNumber: '',
    lineId: FILL_LINES[0].id,
    startTime: '08:00',
  });
  const [lineSettings, setLineSettings] = useState(() =>
    createDefaultLineSettings(FILL_LINES, BOTTLE_SIZES, DEFAULT_FILL_RATE_BY_BOTTLE),
  );
  const [lineSettingsDraft, setLineSettingsDraft] = useState(() =>
    createDefaultLineSettings(FILL_LINES, BOTTLE_SIZES, DEFAULT_FILL_RATE_BY_BOTTLE),
  );
  const [lineSettingsError, setLineSettingsError] = useState('');
  const [lineSettingsInfo, setLineSettingsInfo] = useState('');
  const [lineListDragState, setLineListDragState] = useState({ draggedOrderId: null, overOrderId: null });
  const [lineTimelineDragState, setLineTimelineDragState] = useState({ draggedOrderId: null, overOrderId: null });
  const [mixerDropTargetId, setMixerDropTargetId] = useState(null);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [istSession, setIstSession] = useState(null);
  const [istError, setIstError] = useState('');
  const [istInfo, setIstInfo] = useState('');
  const [istLineId, setIstLineId] = useState(FILL_LINES[0].id);
  const [restQtyDrafts, setRestQtyDrafts] = useState({});

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

  useEffect(() => {
    const loadedSettings = getLineSettings(FILL_LINES, BOTTLE_SIZES, DEFAULT_FILL_RATE_BY_BOTTLE);
    setLineSettings(loadedSettings);
    setLineSettingsDraft(loadedSettings);

    const rawSchedule = localStorage.getItem(SCHEDULE_STORAGE_KEY);
    if (!rawSchedule) return;

    try {
      const parsed = JSON.parse(rawSchedule);
      const normalizedOrders = Array.isArray(parsed?.orders)
        ? parsed.orders.map((entry) => normalizeOrderOnLoad(entry, loadedSettings)).filter(Boolean)
        : [];

      const normalizedReservations = Array.isArray(parsed?.mixerReservations)
        ? parsed.mixerReservations.filter(
            (entry) =>
              entry &&
              typeof entry === 'object' &&
              typeof entry.orderId === 'string' &&
              Number.isFinite(Number(entry.start)) &&
              Number.isFinite(Number(entry.end)) &&
              Number(entry.end) > Number(entry.start),
          )
        : [];

      setOrders(normalizedOrders);
      setMixerReservations(normalizedReservations);
    } catch {
      setOrders([]);
      setMixerReservations([]);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify({ orders, mixerReservations }));
  }, [orders, mixerReservations]);

  useEffect(() => {
    setLineSettingsDraft(lineSettings);
  }, [lineSettings]);

  useEffect(() => {
    if (activeTab !== 'ist') return;
    setIstSession((prev) => {
      if (prev?.dirty) return prev;
      return createIstSession({
        date: new Date().toISOString().slice(0, 10),
        orders,
        mixerReservations,
      });
    });
    setIstError('');
    setIstInfo('');
  }, [activeTab, orders, mixerReservations]);

  useEffect(() => {
    if (!istSession) return;
    const nextDrafts = {};
    istSession.lines.forEach((line) => {
      line.positions.forEach((position) => {
        nextDrafts[position.orderId] = String(position.restQty);
      });
    });
    setRestQtyDrafts(nextDrafts);
  }, [istSession]);

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
    if (!productForm.articleNumber.trim()) {
      setProductError('Artikelnummer ist erforderlich.');
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
          articleNumber: productForm.articleNumber,
          manufacturingDurationMin: duration,
        });
      } else {
        await createProduct({
          name: productForm.name,
          articleNumber: productForm.articleNumber,
          manufacturingDurationMin: duration,
        });
      }
      setProductForm({ name: '', articleNumber: '', manufacturingDurationMin: '' });
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
      articleNumber: product.articleNumber,
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
    if (!orderForm.productionOrderNumber.trim()) {
      setPlanError('PA-Nr. ist erforderlich.');
      return;
    }

    const normalizedProductionOrderNumber = orderForm.productionOrderNumber.trim().toUpperCase();
    if (orders.some((entry) => entry.productionOrderNumber === normalizedProductionOrderNumber)) {
      setPlanError('Diese PA-Nr. ist bereits vergeben.');
      return;
    }

    if (!Number.isFinite(volume) || volume <= 0) {
      setPlanError('Bitte eine gültige Menge in Litern (>0) eingeben.');
      return;
    }

    if (!BOTTLE_SIZES.includes(orderForm.bottleSize)) {
      setPlanError('Bitte eine gültige Flaschengröße auswählen.');
      return;
    }

    const selectedRate = Number(lineSettings?.[orderForm.lineId]?.[orderForm.bottleSize]);
    if (!Number.isFinite(selectedRate) || selectedRate <= 0) {
      setPlanError(
        `Für Linie ${orderForm.lineId} und Flaschengröße ${orderForm.bottleSize} ist keine gültige Abfüllrate (>0 L/min) konfiguriert.`,
      );
      return;
    }

    const fillDuration = Math.ceil(volume / selectedRate);
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
      bottleSize: orderForm.bottleSize,
      productionOrderNumber: normalizedProductionOrderNumber,
      fillDuration,
      manufacturingDuration,
      lineId: orderForm.lineId,
      start,
      end,
      mixerId: null,
      locked: false,
    };

    setOrders((prev) => [...prev, newOrder].sort((a, b) => a.start - b.start));
    setOrderForm((prev) => ({ ...prev, volumeLiters: '', productionOrderNumber: '' }));
    setSelectedOrderId(newOrder.id);
  };

  const updateLineSettingsDraftValue = (lineId, bottleSize, rawValue) => {
    setLineSettingsError('');
    setLineSettingsInfo('');
    setLineSettingsDraft((prev) => ({
      ...prev,
      [lineId]: {
        ...prev[lineId],
        [bottleSize]: rawValue,
      },
    }));
  };

  const onSaveLineSettings = async (event) => {
    event.preventDefault();
    setLineSettingsError('');
    setLineSettingsInfo('');

    const normalized = {};
    for (const line of FILL_LINES) {
      normalized[line.id] = {};
      for (const bottleSize of BOTTLE_SIZES) {
        const nextValue = normalizeLineSettingsValue(lineSettingsDraft?.[line.id]?.[bottleSize]);
        if (!Number.isFinite(nextValue) || nextValue <= 0) {
          setLineSettingsError(`Bitte für ${line.name} und ${BOTTLE_SIZE_LABELS[bottleSize]} einen gültigen Wert > 0 eingeben.`);
          return;
        }
        normalized[line.id][bottleSize] = nextValue;
      }
    }

    await saveLineSettings(normalized, FILL_LINES, BOTTLE_SIZES, DEFAULT_FILL_RATE_BY_BOTTLE);
    setLineSettings(normalized);
    setLineSettingsDraft(normalized);
    setLineSettingsInfo('Linien-Einstellungen wurden gespeichert.');
  };

  const onResetLineSettingsDraft = () => {
    setLineSettingsDraft(lineSettings);
    setLineSettingsError('');
    setLineSettingsInfo('Änderungen wurden zurückgesetzt.');
  };

  const assignOrderToMixer = (orderId, mixerId) => {
    setPlanError('');
    setConflictBlockIds([]);
    if (!orderId) {
      setPlanError('Bitte offenen Auftrag wählen.');
      return false;
    }

    const order = orders.find((entry) => entry.id === orderId);
    if (!order || order.mixerId) {
      setPlanError('Gewählter Auftrag ist nicht mehr offen.');
      return false;
    }

    if (order.locked) {
      setPlanError('Gesperrte Aufträge können nicht neu zugewiesen werden.');
      return false;
    }

    const manufacturingBlock = {
      id: crypto.randomUUID(),
      mixerId,
      orderId: order.id,
      start: order.start - order.manufacturingDuration,
      end: order.start,
      type: 'manufacturing',
    };

    if (manufacturingBlock.start < 0) {
      setPlanError('Zuweisung nicht möglich: Herstellungszeitraum liegt vor 00:00 Uhr.');
      setConflictBlockIds([manufacturingBlock.id]);
      return false;
    }

    const mixerBlocks = timelineBlocks.filter((entry) => entry.mixerId === mixerId);
    const conflictingMixerBlocks = mixerBlocks.filter((entry) => overlaps(manufacturingBlock, entry));
    if (conflictingMixerBlocks.length > 0) {
      setPlanError('Zuweisung nicht möglich: Herstellungsblock kollidiert mit vorhandener Rührwerks-Reservierung.');
      setConflictBlockIds([manufacturingBlock.id, ...conflictingMixerBlocks.map((entry) => entry.id)]);
      return false;
    }

    setOrders((prev) => prev.map((entry) => (entry.id === orderId ? { ...entry, mixerId } : entry)));
    setMixerReservations((prev) => [...prev, manufacturingBlock]);
    setSelectedOrderId((prev) => (prev === orderId ? '' : prev));
    return true;
  };

  const assignOrderToMixerByDrop = (orderId, mixerId) => assignOrderToMixer(orderId, mixerId);

  const tryAssignOrderToMixer = () => {
    assignOrderToMixer(selectedOrderId, selectedMixerId);
  };

  const unassignOrderFromMixer = (orderId) => {
    const order = orders.find((entry) => entry.id === orderId);
    if (!order || !order.mixerId) return;
    if (order.locked) {
      setPlanError('Gesperrte Aufträge können nicht entkoppelt werden.');
      return;
    }

    setConflictBlockIds([]);
    setOrders((prev) => prev.map((entry) => (entry.id === orderId ? { ...entry, mixerId: null } : entry)));
    setMixerReservations((prev) => prev.filter((entry) => entry.orderId !== orderId));
  };

  const toggleOrderLock = (orderId) => {
    setPlanError('');
    setOrders((prev) => {
      const order = prev.find((entry) => entry.id === orderId);
      if (!order) return prev;
      if (!order.mixerId) {
        setPlanError('Lock ist erst nach Zuweisung zu einem Rührwerk möglich.');
        return prev;
      }
      return prev.map((entry) => (entry.id === orderId ? { ...entry, locked: !entry.locked } : entry));
    });
  };

  const removeOrder = (orderId) => {
    const order = orders.find((entry) => entry.id === orderId);
    if (!order) return;
    if (order.locked) {
      setPlanError('Gesperrte Aufträge können nicht gelöscht werden.');
      return;
    }

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

      const movedOrder = lineOrders[fromIndex];
      const targetOrder = lineOrders[toIndex];
      if (movedOrder?.locked || targetOrder?.locked) {
        setPlanError('Gesperrte Aufträge können in der Reihenfolge nicht verschoben werden.');
        return prevOrders;
      }

      const reorderedLineOrders = [...lineOrders];
      const [moved] = reorderedLineOrders.splice(fromIndex, 1);
      reorderedLineOrders.splice(toIndex, 0, moved);

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

  const rowsByLine = useMemo(
    () =>
      FILL_LINES.map((line) => ({
        ...line,
        orders: (lineOrdersById[line.id] ?? []).toSorted((a, b) => a.start - b.start),
      })),
    [lineOrdersById],
  );

  const timelineScaleTicks = useMemo(() => {
    const ticks = [];
    for (let minute = 0; minute <= DAY_MINUTES; minute += TIMELINE_SCALE_TICK_MINUTES) {
      ticks.push(minute);
    }
    if (ticks[ticks.length - 1] !== DAY_MINUTES) {
      ticks.push(DAY_MINUTES);
    }
    return ticks;
  }, []);

  const updateTimelineZoom = (nextZoom) => {
    const clamped = Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, nextZoom));
    setTimelineZoom(Number(clamped.toFixed(2)));
  };

  const startLineListDrag = (event, orderId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/order-id', orderId);
    setLineListDragState({ draggedOrderId: orderId, overOrderId: null });
  };

  const onLineListDragOver = (event, overOrderId) => {
    event.preventDefault();
    setLineListDragState((prev) => (prev.overOrderId === overOrderId ? prev : { ...prev, overOrderId }));
  };

  const finishLineListDrag = () => {
    setLineListDragState({ draggedOrderId: null, overOrderId: null });
  };

  const dropOnLineList = (event, lineId, targetOrderId) => {
    event.preventDefault();
    const movedOrderId = event.dataTransfer.getData('text/order-id') || lineListDragState.draggedOrderId;
    finishLineListDrag();
    if (!movedOrderId || !targetOrderId || movedOrderId === targetOrderId) return;
    handleLineListDrop(lineId, movedOrderId, targetOrderId);
  };

  const startLineTimelineDrag = (event, orderId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/order-id', orderId);
    setLineTimelineDragState({ draggedOrderId: orderId, overOrderId: null });
  };

  const onLineTimelineDragOver = (event, overOrderId) => {
    event.preventDefault();
    setLineTimelineDragState((prev) => (prev.overOrderId === overOrderId ? prev : { ...prev, overOrderId }));
  };

  const finishLineTimelineDrag = () => {
    setLineTimelineDragState({ draggedOrderId: null, overOrderId: null });
  };

  const dropOnLineTimeline = (event, lineId, targetOrderId) => {
    event.preventDefault();
    const movedOrderId = event.dataTransfer.getData('text/order-id') || lineTimelineDragState.draggedOrderId;
    finishLineTimelineDrag();
    if (!movedOrderId || !targetOrderId || movedOrderId === targetOrderId) return;
    handleLineListDrop(lineId, movedOrderId, targetOrderId);
  };

  const startOpenOrderDrag = (event, orderId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/order-id', orderId);
  };

  const onMixerDragOver = (event, mixerId) => {
    event.preventDefault();
    setMixerDropTargetId(mixerId);
  };

  const onMixerDrop = (event, mixerId) => {
    event.preventDefault();
    const orderId = event.dataTransfer.getData('text/order-id');
    setMixerDropTargetId(null);
    if (!orderId) return;
    assignOrderToMixerByDrop(orderId, mixerId);
  };

  const clearMixerDropTarget = () => {
    setMixerDropTargetId(null);
  };

  const activeIstLine = istSession?.lines.find((line) => line.lineId === istLineId) ?? null;

  const onChangeRestQtyDraft = (orderId, value) => {
    setRestQtyDrafts((prev) => ({ ...prev, [orderId]: value }));
  };

  const onSaveRestQty = (orderId) => {
    if (!istSession) return;
    setIstError('');
    setIstInfo('');

    try {
      const next = saveRestQty(istSession, {
        orderId,
        restQty: restQtyDrafts[orderId],
        expectedVersion: istSession.version,
        mixerReservations,
      });
      setIstSession(next);
      setIstInfo('Änderung gespeichert. Timeline und Konfliktstatus wurden aktualisiert.');
    } catch (error) {
      if (error?.message === 'IST-VAL-001') {
        setIstError('Restmenge muss eine Zahl >= 0 sein.');
        return;
      }
      if (error?.message === 'IST-VAL-002') {
        setIstError('Restmenge darf Startmenge nicht überschreiten.');
        return;
      }
      setIstError('Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.');
    }
  };

  const onDeleteIstOrder = (orderId) => {
    if (!istSession) return;
    const confirmed = window.confirm(
      'Auftrag wirklich löschen? Dieser Schritt kann per Undo rückgängig gemacht werden.',
    );
    if (!confirmed) return;

    setIstError('');
    setIstInfo('');

    try {
      const next = deleteIstOrder(istSession, {
        orderId,
        expectedVersion: istSession.version,
        mixerReservations,
      });
      setIstSession(next);
      setIstInfo('Auftrag wurde gelöscht. Positionen wurden nachgerückt.');
    } catch {
      setIstError('Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.');
    }
  };

  const onUndoIst = () => {
    if (!istSession) return;
    const next = undoIst(istSession, { mixerReservations });
    setIstSession(next);
    setIstError('');
    setIstInfo('Letzte Änderung wurde rückgängig gemacht.');
  };

  const onPublishIst = () => {
    if (!istSession) return;
    setIstError('');
    setIstInfo('');

    try {
      publishIst(istSession, { expectedVersion: istSession.version });
      const publishedOrders = convertSessionToOrders(istSession, orders);
      setOrders(publishedOrders);
      setMixerReservations((prev) => prev.filter((entry) => publishedOrders.some((order) => order.id === entry.orderId)));
      setIstSession((prev) => (prev ? { ...prev, dirty: false, canUpdatePlanner: false } : prev));
      setIstInfo('IST-Änderungen wurden in den Hauptplaner übernommen.');
    } catch (error) {
      if (error?.message === 'IST-CONF-001') {
        setIstError('Rührwerksüberschneidung erkannt. „Planer aktualisieren“ ist gesperrt.');
        return;
      }
      setIstError('Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.');
    }
  };

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
          className={activeTab === 'ist' ? 'tab-active' : ''}
          onClick={() => setActiveTab('ist')}
        >
          IST
        </button>
        <button
          type="button"
          className={activeTab === 'stammdaten' ? 'tab-active' : ''}
          onClick={() => setActiveTab('stammdaten')}
        >
          Stammdaten
        </button>
        <button
          type="button"
          className={activeTab === 'linien-einstellung' ? 'tab-active' : ''}
          onClick={() => setActiveTab('linien-einstellung')}
        >
          Linien-Einstellung
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
                      {product.name} ({product.articleNumber})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                PA-Nr. (eindeutig)
                <input
                  value={orderForm.productionOrderNumber}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, productionOrderNumber: e.target.value }))}
                  placeholder="z. B. PA-2026-0001"
                />
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
                Flaschengröße
                <select
                  value={orderForm.bottleSize}
                  onChange={(e) => setOrderForm((prev) => ({ ...prev, bottleSize: e.target.value }))}
                >
                  {BOTTLE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {BOTTLE_SIZE_LABELS[size] ?? size}
                    </option>
                  ))}
                </select>
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
              Hinweis: Die Abfüllzeit wird je Linie und Flaschengröße aus den konfigurierten L/min berechnet
              (z. B. 1L = 30, 0.5L = 15). Die Herstellungsdauer kommt aus den Produkt-Stammdaten. Für die
              Planung zählt jeweils der längere Wert.
            </p>
            {planError && <p className="error">{planError}</p>}
          </section>

          <section className="panel">
            <h2>Auftragsliste je Abfülllinie (Drag & Drop)</h2>
            <div className="line-lists-grid">
              {rowsByLine.map((line) => (
                <article key={line.id} className="line-list-card">
                  <h3>{line.name}</h3>
                  {line.orders.length === 0 ? (
                    <p>Keine Aufträge vorhanden.</p>
                  ) : (
                    <ul>
                      {line.orders.map((order) => {
                        const isDropTarget =
                          lineListDragState.overOrderId === order.id && lineListDragState.draggedOrderId !== order.id;
                        return (
                          <li
                            key={order.id}
                            draggable={!order.locked}
                            className={`${getOrderStatus(order)} ${isDropTarget ? 'drop-target' : ''}`}
                            onDragStart={(event) => !order.locked && startLineListDrag(event, order.id)}
                            onDragOver={(event) => onLineListDragOver(event, order.id)}
                            onDrop={(event) => dropOnLineList(event, line.id, order.id)}
                            onDragEnd={finishLineListDrag}
                          >
                            <div className="line-order-header">
                              <span>{order.productName}</span>
                              <div className="mini-actions">
                                <button type="button" className="danger" title="Auftrag löschen" onClick={() => removeOrder(order.id)}>
                                  🗑
                                </button>
                                <button
                                  type="button"
                                  className="secondary"
                                  title="Zuweisung lösen"
                                  onClick={() => unassignOrderFromMixer(order.id)}
                                  disabled={!order.mixerId || order.locked}
                                >
                                  🔓
                                </button>
                                <button
                                  type="button"
                                  className={order.locked ? '' : 'secondary'}
                                  title="Lock"
                                  onClick={() => toggleOrderLock(order.id)}
                                  disabled={!order.mixerId}
                                >
                                  {order.locked ? '🔒' : '🔐'}
                                </button>
                              </div>
                            </div>
                            <small>
                              {toHHMM(order.start)}-{toHHMM(order.end)} · {order.volumeLiters} L · Flasche{' '}
                              {BOTTLE_SIZE_LABELS[order.bottleSize] ?? order.bottleSize}
                            </small>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Zeitstrahl Abfülllinien (Drag & Drop Reihenfolge)</h2>
            <div className="timeline-zoom-controls">
              <strong>Zoom</strong>
              <button type="button" className="secondary" onClick={() => updateTimelineZoom(timelineZoom - TIMELINE_ZOOM_STEP)}>
                −
              </button>
              <input
                type="range"
                min={TIMELINE_ZOOM_MIN}
                max={TIMELINE_ZOOM_MAX}
                step={TIMELINE_ZOOM_STEP}
                value={timelineZoom}
                onChange={(event) => updateTimelineZoom(Number(event.target.value))}
              />
              <button type="button" className="secondary" onClick={() => updateTimelineZoom(timelineZoom + TIMELINE_ZOOM_STEP)}>
                +
              </button>
              <span>{timelineZoom.toFixed(2)}x</span>
            </div>
            <div className="timeline-scroll">
              <div className="timeline-scroll-inner" style={{ width: `${timelineZoom * 100}%` }}>
                <div className="timeline-scale-row">
                  <div className="timeline-scale-label">Skala</div>
                  <div className="timeline-scale-track">
                    {timelineScaleTicks.map((tick) => (
                      <div key={tick} className="timeline-scale-tick" style={{ left: `${(tick / DAY_MINUTES) * 100}%` }}>
                        <span>{toHHMM(tick)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="timeline-grid">
                  {rowsByLine.map((line) => (
                    <div key={line.id} className="timeline-row">
                      <div className="timeline-label">{line.name}</div>
                      <div className="timeline-track">
                        {line.orders.map((order) => {
                          const isDropTarget =
                            lineTimelineDragState.overOrderId === order.id && lineTimelineDragState.draggedOrderId !== order.id;
                          const lineOrderLabel = `${order.productName} · PA-Nr. ${order.productionOrderNumber} · ${order.volumeLiters} L · ${BOTTLE_SIZE_LABELS[order.bottleSize] ?? order.bottleSize}`;
                          return (
                            <div
                              key={order.id}
                              className={`block line-order ${getOrderStatus(order)} ${isDropTarget ? 'drop-target' : ''}`}
                              style={{
                                left: `${(order.start / DAY_MINUTES) * 100}%`,
                                width: `${Math.max(((order.end - order.start) / DAY_MINUTES) * 100, 0.9)}%`,
                              }}
                              title={`${lineOrderLabel} · ${toHHMM(order.start)}-${toHHMM(order.end)}`}
                              draggable={!order.locked}
                              onDragStart={(event) => !order.locked && startLineTimelineDrag(event, order.id)}
                              onDragOver={(event) => onLineTimelineDragOver(event, order.id)}
                              onDrop={(event) => dropOnLineTimeline(event, line.id, order.id)}
                              onDragEnd={finishLineTimelineDrag}
                            >
                              {lineOrderLabel}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Offenen Auftrag einem Rührwerk zuweisen</h2>
            <div className="open-orders-dnd-source">
              <strong>Draggable offene Aufträge:</strong>
              <div className="open-order-chips">
                {openOrders.length === 0 ? (
                  <span>Keine offenen Aufträge.</span>
                ) : (
                  openOrders.map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      className="secondary open-order-chip"
                      draggable
                      onDragStart={(event) => startOpenOrderDrag(event, order.id)}
                    >
                      {order.productionOrderNumber} · {order.productName} · {order.lineId} · {toHHMM(order.start)}-{toHHMM(order.end)}
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="assign-row">
              <label>
                Offener Auftrag
                <select value={selectedOrderId} onChange={(e) => setSelectedOrderId(e.target.value)}>
                  <option value="">Bitte wählen</option>
                  {openOrders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.productionOrderNumber} · {order.productName} · {order.lineId} · {toHHMM(order.start)}-{toHHMM(order.end)}
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
            <h2>Zeitstrahl Rührwerke</h2>
            <div className="timeline-scroll">
              <div className="timeline-scroll-inner" style={{ width: `${timelineZoom * 100}%` }}>
                <div className="timeline-scale-row">
                  <div className="timeline-scale-label">Skala</div>
                  <div className="timeline-scale-track">
                    {timelineScaleTicks.map((tick) => (
                      <div key={tick} className="timeline-scale-tick" style={{ left: `${(tick / DAY_MINUTES) * 100}%` }}>
                        <span>{toHHMM(tick)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="timeline-grid">
                  {MIXERS.map((mixer) => (
                    <div key={mixer.id} className="timeline-row">
                      <div className="timeline-label">{mixer.name}</div>
                      <div
                        className={`timeline-track ${mixerDropTargetId === mixer.id ? 'mixer-drop-active' : ''}`}
                        onDragOver={(event) => onMixerDragOver(event, mixer.id)}
                        onDragLeave={clearMixerDropTarget}
                        onDrop={(event) => onMixerDrop(event, mixer.id)}
                      >
                        {timelineBlocks
                          .filter((reservation) => reservation.mixerId === mixer.id)
                          .map((reservation) => {
                            const relatedOrder = orders.find((entry) => entry.id === reservation.orderId);
                            const blockStatus = relatedOrder ? getOrderStatus(relatedOrder) : 'assigned';
                            return (
                            <div
                              key={reservation.id}
                              className={`block ${reservation.type} ${blockStatus} ${conflictBlockIds.includes(reservation.id) ? 'conflict' : ''}`}
                              style={{
                                left: `${(reservation.start / DAY_MINUTES) * 100}%`,
                                width: `${((reservation.end - reservation.start) / DAY_MINUTES) * 100}%`,
                              }}
                              title={`Auftrag ${reservation.orderId} · ${relatedOrder?.productionOrderNumber ?? ''} · ${relatedOrder?.productName ?? ''} · ${BOTTLE_SIZE_LABELS[relatedOrder?.bottleSize] ?? relatedOrder?.bottleSize ?? '-'} · ${toHHMM(reservation.start)}-${toHHMM(reservation.end)}`}
                            >
                              {reservation.type === 'manufacturing' ? 'H' : 'A'}
                            </div>
                          );
                          })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Aufträge</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>PA-Nr.</th>
                  <th>Produkt</th>
                  <th>Menge</th>
                  <th>Flaschengröße</th>
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
                    <td>{order.productionOrderNumber}</td>
                    <td>{order.productName}</td>
                    <td>{order.volumeLiters} L</td>
                    <td>{BOTTLE_SIZE_LABELS[order.bottleSize] ?? order.bottleSize}</td>
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
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => unassignOrderFromMixer(order.id)}
                            disabled={order.locked}
                          >
                            Entkoppeln
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={order.locked ? '' : 'secondary'}
                          onClick={() => toggleOrderLock(order.id)}
                          disabled={!order.mixerId}
                        >
                          {order.locked ? 'Locked' : 'Lock'}
                        </button>
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
                    <td colSpan="11">Noch keine Aufträge vorhanden.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </>
      ) : activeTab === 'ist' ? (
        <>
          <section className="panel">
            <h2>IST</h2>
            <p>Restmengen werden immer auf 06:00 neu geankert. Nach jeder Änderung erfolgt eine Konfliktprüfung.</p>
            <div className="ist-line-tabs">
              {FILL_LINES.map((line) => (
                <button
                  key={line.id}
                  type="button"
                  className={istLineId === line.id ? 'tab-active' : 'secondary'}
                  onClick={() => setIstLineId(line.id)}
                >
                  {line.name}
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Linie {istLineId}</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>PA-Nr.</th>
                  <th>Status</th>
                  <th>Startmenge</th>
                  <th>Restmenge</th>
                  <th>Dauer</th>
                  <th>Zeit</th>
                  <th>Locked</th>
                  <th>Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {(activeIstLine?.positions ?? []).slice(0, 3).map((position) => (
                  <tr key={position.orderId}>
                    <td>Pos.{position.position}</td>
                    <td>{position.productionOrderNumber}</td>
                    <td>{position.status}</td>
                    <td>{position.startQty}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={restQtyDrafts[position.orderId] ?? ''}
                        onChange={(event) => onChangeRestQtyDraft(position.orderId, event.target.value)}
                      />
                    </td>
                    <td>{position.durationMin} min</td>
                    <td>
                      {position.startAt} - {position.endAt}
                    </td>
                    <td>{position.locked ? 'Ja' : 'Nein'}</td>
                    <td>
                      <div className="actions">
                        <button type="button" onClick={() => onSaveRestQty(position.orderId)}>
                          Speichern
                        </button>
                        <button type="button" className="danger" onClick={() => onDeleteIstOrder(position.orderId)}>
                          Löschen
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!activeIstLine?.positions?.length ? (
                  <tr>
                    <td colSpan="9">Keine Aufträge in der gewählten Linie.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <div className="ist-footer-actions">
              <p className={istSession?.hasConflicts ? 'error' : ''}>
                {istSession?.hasConflicts
                  ? 'Rührwerksüberschneidung erkannt. Bitte Konflikt lösen, bevor der Hauptplaner aktualisiert werden kann.'
                  : 'Keine Überschneidung. Änderungen können in den Hauptplaner übernommen werden.'}
              </p>
              <div className="actions">
                <button type="button" className="secondary" onClick={onUndoIst} disabled={!istSession?.history?.length}>
                  Undo
                </button>
                <button
                  type="button"
                  onClick={onPublishIst}
                  disabled={!(istSession?.canUpdatePlanner && istSession?.dirty)}
                >
                  Planer aktualisieren
                </button>
              </div>
            </div>
            {istError ? <p className="error">{istError}</p> : null}
            {istInfo ? <p>{istInfo}</p> : null}
          </section>
        </>
      ) : activeTab === 'linien-einstellung' ? (
        <section className="panel">
          <h2>Linien-Einstellung</h2>
          <form onSubmit={onSaveLineSettings}>
            <table className="data-table line-settings-table">
              <thead>
                <tr>
                  <th>Abfülllinie</th>
                  {BOTTLE_SIZES.map((size) => (
                    <th key={size}>{BOTTLE_SIZE_LABELS[size] ?? size}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FILL_LINES.map((line) => (
                  <tr key={line.id}>
                    <td>{line.name}</td>
                    {BOTTLE_SIZES.map((size) => (
                      <td key={size}>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={lineSettingsDraft?.[line.id]?.[size] ?? ''}
                          onChange={(event) => updateLineSettingsDraftValue(line.id, size, event.target.value)}
                          required
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="actions top-space">
              <button type="submit">Speichern</button>
              <button type="button" className="secondary" onClick={onResetLineSettingsDraft}>
                Zurücksetzen
              </button>
            </div>
          </form>
          {lineSettingsError ? <p className="error">{lineSettingsError}</p> : null}
          {lineSettingsInfo ? <p>{lineSettingsInfo}</p> : null}
        </section>
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
              Artikelnummer (eindeutig)
              <input
                value={productForm.articleNumber}
                onChange={(e) => setProductForm((prev) => ({ ...prev, articleNumber: e.target.value }))}
                placeholder="z. B. ART-4711"
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
                  setProductForm({ name: '', articleNumber: '', manufacturingDurationMin: '' });
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
                <th>Artikelnummer</th>
                <th>Herstellungsdauer</th>
                <th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>{product.name}</td>
                  <td>{product.articleNumber}</td>
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
