import { useState, useEffect, useCallback, createContext, useContext, useRef } from "react";

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const CFG = {
  SLUG: "filmsupport-d93f",
  KEY: "b4fa0a2776238d680da685ac37fa7a9047551017d4bba65792b4a1987ae699db",
  V1: "https://filmsupport-d93f.booqable.com/api/1",
  V4: "https://filmsupport-d93f.booqable.com/api/4",
};

// ═══════════════════════════════════════════════
// API LAYER — swap for own backend later
// ═══════════════════════════════════════════════
const api = {
  async req(path, opts = {}, v = 1) {
    const base = v === 4 ? CFG.V4 : CFG.V1;
    const sep = path.includes("?") ? "&" : "?";
    const url = `${base}${path}${sep}api_key=${CFG.KEY}`;
    const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  orders: {
    list: (p = {}) => api.req(`/orders?${new URLSearchParams({ per: 100, ...p })}`),
    get: (id) => api.req(`/orders/${id}?include=lines,customer`),
    updateStatus: (id, transition) =>
      api.req(`/orders/${id}`, { method: "PUT", body: JSON.stringify({ order: { status: transition } }) }),
  },
  customers: {
    list: () => api.req("/customers?per=200"),
    get: (id) => api.req(`/customers/${id}`),
  },
  products: {
    list: () => api.req("/product_groups?per=200"),
  },
  lines: {
    forOrder: (orderId) => api.req(`/orders/${orderId}/lines`),
  },
};

// ═══════════════════════════════════════════════
// TOKENS
// ═══════════════════════════════════════════════
const C = {
  bg: "#070709",
  s0: "#0d0d12",
  s1: "#111118",
  s2: "#16161e",
  s3: "#1c1c27",
  border: "#222230",
  borderHi: "#2e2e40",
  gold: "#e8c84a",
  goldDim: "#b89a30",
  goldGlow: "rgba(232,200,74,0.10)",
  red: "#e05555",
  green: "#3fd68a",
  blue: "#4a8fe8",
  orange: "#e8894a",
  purple: "#9b6ee8",
  t1: "#f0eee8",
  t2: "#9090a8",
  t3: "#505060",
  font: "'Inter', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'Fira Mono', monospace",
};

const STATUS_MAP = {
  new:      { label: "Nová",        color: C.t3,     bg: "#111118" },
  concept:  { label: "Koncept",     color: C.blue,   bg: "#0c1520" },
  reserved: { label: "Rezervovaná", color: C.gold,   bg: "#181400" },
  started:  { label: "Vydaná",      color: C.orange, bg: "#180c00" },
  stopped:  { label: "Vrátená",     color: C.green,  bg: "#001510" },
  archived: { label: "Archív",      color: C.t3,     bg: "#111118" },
  canceled: { label: "Zrušená",     color: C.red,    bg: "#180a0a" },
};

// Custom prep states (local, not in Booqable)
const PREP_STATES = {
  pending:   { label: "Čaká na prípravu", color: C.t3,    icon: "○" },
  prepping:  { label: "Prebieha príprava", color: C.blue,  icon: "◔" },
  ready:     { label: "Pripravené",        color: C.green, icon: "●" },
  issue:     { label: "Problém",           color: C.red,   icon: "⚠" },
};

// ═══════════════════════════════════════════════
// LOCAL STORAGE HELPERS (prep data, notes, checks)
// ═══════════════════════════════════════════════
const LS = {
  get: (k, def = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ═══════════════════════════════════════════════
// APP CONTEXT
// ═══════════════════════════════════════════════
const Ctx = createContext(null);
function AppProvider({ children }) {
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [synced, setSynced] = useState(null);
  // Local prep data: { [orderId]: { state, checklist: {lineId: bool}, notes, issues: [], prepBy } }
  const [prepData, setPrepData] = useState(() => LS.get("fs_prep", {}));

  const savePrepData = useCallback((next) => {
    setPrepData(next);
    LS.set("fs_prep", next);
  }, []);

  const syncAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [o, c, p] = await Promise.all([
        api.orders.list(),
        api.customers.list(),
        api.products.list(),
      ]);
      setOrders(o.orders || []);
      setCustomers(c.customers || []);
      setProducts(p.product_groups || []);
      setSynced(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { syncAll(); }, [syncAll]);

  return (
    <Ctx.Provider value={{ orders, customers, products, loading, error, synced, syncAll, prepData, savePrepData }}>
      {children}
    </Ctx.Provider>
  );
}
const useApp = () => useContext(Ctx);

// ═══════════════════════════════════════════════
// UI ATOMS
// ═══════════════════════════════════════════════
const css = (obj) => Object.entries(obj).map(([k, v]) => `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}:${v}`).join(";");

function Badge({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.new;
  return <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}44`, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{s.label}</span>;
}
function PrepBadge({ state }) {
  const s = PREP_STATES[state] || PREP_STATES.pending;
  return <span style={{ color: s.color, fontSize: 11, fontWeight: 600 }}>{s.icon} {s.label}</span>;
}
function Card({ children, style = {}, onClick }) {
  return <div onClick={onClick} style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, ...style, cursor: onClick ? "pointer" : "default" }}>{children}</div>;
}
function Spin() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60 }}>
      <div style={{ width: 28, height: 28, borderRadius: "50%", border: `2px solid ${C.border}`, borderTopColor: C.gold, animation: "spin .7s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
function Empty({ icon, title, sub }) {
  return <div style={{ textAlign: "center", padding: "48px 16px", color: C.t3 }}><div style={{ fontSize: 32, marginBottom: 10 }}>{icon}</div><div style={{ color: C.t2, fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{title}</div><div style={{ fontSize: 12 }}>{sub}</div></div>;
}
function Btn({ children, onClick, v = "ghost", disabled = false, style = {} }) {
  const base = { cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontWeight: 600, fontFamily: C.font, border: "none", borderRadius: 7, padding: "7px 14px", fontSize: 12, transition: "all .15s", ...style };
  const vars = {
    primary: { background: C.gold, color: "#000" },
    ghost:   { background: C.s2, color: C.t2, border: `1px solid ${C.border}` },
    danger:  { background: "#1a0808", color: C.red, border: `1px solid ${C.red}44` },
    success: { background: "#001510", color: C.green, border: `1px solid ${C.green}44` },
    orange:  { background: "#180c00", color: C.orange, border: `1px solid ${C.orange}44` },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...vars[v] }}>{children}</button>;
}
function Input({ value, onChange, placeholder, style = {} }) {
  return <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.t1, fontSize: 13, outline: "none", fontFamily: C.font, ...style }} />;
}
function ProgressBar({ pct, color = C.gold }) {
  return <div style={{ background: C.border, borderRadius: 4, height: 5, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? C.green : color, borderRadius: 4, transition: "width .3s, background .3s" }} /></div>;
}

// ═══════════════════════════════════════════════
// MODULES
// ═══════════════════════════════════════════════

// ── DASHBOARD ──────────────────────────────────
function Dashboard({ nav }) {
  const { orders, customers, loading, error, synced, syncAll } = useApp();
  const today = new Date().toISOString().split("T")[0];

  const active  = orders.filter(o => o.status === "started");
  const goingOut = orders.filter(o => o.status === "reserved" && o.starts_at?.slice(0,10) === today);
  const returning = orders.filter(o => o.status === "started" && o.stops_at?.slice(0,10) === today);
  const overdue = orders.filter(o => o.status === "started" && o.stops_at && o.stops_at.slice(0,10) < today);
  const totalRev = orders.filter(o => o.status !== "canceled").reduce((s,o) => s + (o.grand_total_in_cents||0), 0) / 100;

  const kpis = [
    { label: "Vonku práve teraz", value: active.length, color: C.orange, click: () => nav("orders") },
    { label: "Dnes vychádza", value: goingOut.length, color: C.gold, click: () => nav("picking") },
    { label: "Dnes vracia", value: returning.length, color: C.green, click: () => nav("checkin") },
    { label: "⚠ Meškajú", value: overdue.length, color: overdue.length > 0 ? C.red : C.t3, click: () => nav("orders") },
    { label: "Zákazníci", value: customers.length, color: C.blue },
    { label: "Tržby celkom", value: `€${totalRev.toFixed(0)}`, color: C.t1 },
  ];

  return (
    <div>
      {error && <div style={{ background: "#1a0808", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 16px", color: C.red, fontSize: 13, marginBottom: 16 }}>⚠ API chyba: {error}</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: C.t1, fontSize: 16, fontWeight: 700 }}>Prehľad dňa</h2>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {synced && <span style={{ fontSize: 11, color: C.t3 }}>sync {synced.toLocaleTimeString("sk-SK")}</span>}
          <Btn onClick={syncAll} v="ghost">↺ Sync</Btn>
        </div>
      </div>

      {loading ? <Spin /> : (
        <>
          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
            {kpis.map(k => (
              <Card key={k.label} onClick={k.click} style={{ textAlign: "center", padding: "18px 12px", ...(k.click ? { cursor: "pointer" } : {}) }}
                onMouseEnter={e => k.click && (e.currentTarget.style.borderColor = C.gold + "66")}
                onMouseLeave={e => k.click && (e.currentTarget.style.borderColor = C.border)}
              >
                <div style={{ fontSize: 30, fontWeight: 800, color: k.color, lineHeight: 1 }}>{k.value}</div>
                <div style={{ fontSize: 11, color: C.t3, marginTop: 6, letterSpacing: "0.06em", textTransform: "uppercase" }}>{k.label}</div>
              </Card>
            ))}
          </div>

          {/* Today panels */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <Card>
              <div style={{ fontSize: 12, color: C.gold, fontWeight: 700, marginBottom: 12, letterSpacing: "0.06em" }}>→ DNES VYCHÁDZA ({goingOut.length})</div>
              {goingOut.length === 0 ? <Empty icon="📅" title="Nič na dnes" sub="" /> : goingOut.map(o => <OrderRow key={o.id} order={o} onClick={() => nav("picking", o.id)} />)}
            </Card>
            <Card>
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 12, letterSpacing: "0.06em" }}>← DNES VRACIA ({returning.length})</div>
              {returning.length === 0 ? <Empty icon="✅" title="Nič sa nevracia" sub="" /> : returning.map(o => <OrderRow key={o.id} order={o} onClick={() => nav("checkin", o.id)} />)}
            </Card>
          </div>

          {/* Overdue alert */}
          {overdue.length > 0 && (
            <Card style={{ borderColor: `${C.red}55`, background: "#120808" }}>
              <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 12, letterSpacing: "0.06em" }}>⚠ MEŠKAJÚ — NEVRÁTENÁ TECHNIKA ({overdue.length})</div>
              {overdue.map(o => (
                <div key={o.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                  <span style={{ color: C.red }}><span style={{ color: C.t2, fontFamily: C.mono }}>#</span><span style={{ color: C.gold, fontFamily: C.mono }}>{o.number}</span> · {o.customer?.name || "—"}</span>
                  <span style={{ color: C.red, fontFamily: C.mono, fontSize: 11 }}>malo sa vrátiť {o.stops_at?.slice(0,10)}</span>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function OrderRow({ order: o, onClick }) {
  return (
    <div onClick={onClick} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}`, cursor: onClick ? "pointer" : "default" }}
      onMouseEnter={e => onClick && (e.currentTarget.style.background = C.s2)}
      onMouseLeave={e => onClick && (e.currentTarget.style.background = "transparent")}
    >
      <div>
        <span style={{ color: C.gold, fontFamily: C.mono, fontSize: 12, fontWeight: 700 }}>#{o.number}</span>
        <span style={{ color: C.t1, fontSize: 13, marginLeft: 8 }}>{o.customer?.name || "—"}</span>
      </div>
      <Badge status={o.status} />
    </div>
  );
}

// ── ORDERS LIST ─────────────────────────────────
function OrdersList({ nav }) {
  const { orders, loading } = useApp();
  const [q, setQ] = useState("");
  const [st, setSt] = useState("all");

  const list = orders.filter(o => {
    const ms = st === "all" || o.status === st;
    const mq = !q || String(o.number).includes(q) || (o.customer?.name||"").toLowerCase().includes(q.toLowerCase());
    return ms && mq;
  }).sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0));

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <Input value={q} onChange={setQ} placeholder="Hľadaj číslo, zákazník…" style={{ flex: 1, minWidth: 180 }} />
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {["all","concept","reserved","started","stopped"].map(s => (
            <button key={s} onClick={() => setSt(s)} style={{ background: st===s ? C.gold : C.s2, color: st===s ? "#000" : C.t2, border: `1px solid ${st===s ? C.gold : C.border}`, borderRadius: 6, padding: "6px 12px", fontSize: 11, cursor: "pointer", fontWeight: st===s ? 700 : 400 }}>
              {s === "all" ? "Všetky" : STATUS_MAP[s]?.label}
            </button>
          ))}
        </div>
      </div>
      <Card style={{ padding: 0 }}>
        {loading ? <Spin /> : list.length === 0 ? <Empty icon="🔍" title="Žiadne výsledky" sub="Zmeňte filter" /> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["#","Zákazník","Od","Do","Status","Suma","Akcia"].map(h => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: C.t3, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map(o => (
                  <tr key={o.id} style={{ borderBottom: `1px solid ${C.border}` }}
                    onMouseEnter={e => e.currentTarget.style.background = C.s2}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  >
                    <td style={{ padding: "11px 16px", color: C.gold, fontFamily: C.mono, fontWeight: 700 }}>#{o.number}</td>
                    <td style={{ padding: "11px 16px", color: C.t1 }}>{o.customer?.name || <span style={{ color: C.t3 }}>—</span>}</td>
                    <td style={{ padding: "11px 16px", color: C.t2, fontFamily: C.mono, fontSize: 11 }}>{o.starts_at?.slice(0,10) || "—"}</td>
                    <td style={{ padding: "11px 16px", color: C.t2, fontFamily: C.mono, fontSize: 11 }}>{o.stops_at?.slice(0,10) || "—"}</td>
                    <td style={{ padding: "11px 16px" }}><Badge status={o.status} /></td>
                    <td style={{ padding: "11px 16px", color: C.t1, fontFamily: C.mono }}>{o.grand_total_in_cents ? `€${(o.grand_total_in_cents/100).toFixed(2)}` : "—"}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        {o.status === "reserved" && <Btn v="orange" onClick={() => nav("picking", o.id)}>→ Vydaj</Btn>}
                        {o.status === "started"  && <Btn v="success" onClick={() => nav("checkin", o.id)}>← Príjem</Btn>}
                        <Btn v="ghost" onClick={() => nav("order_detail", o.id)}>Detail</Btn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div style={{ color: C.t3, fontSize: 11, marginTop: 8 }}>{list.length} / {orders.length} objednávok</div>
    </div>
  );
}

// ── ORDER DETAIL ────────────────────────────────
function OrderDetail({ orderId, nav }) {
  const { orders } = useApp();
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const order = orders.find(o => o.id === orderId);

  useEffect(() => {
    api.orders.get(orderId)
      .then(d => setFull(d.order || d))
      .catch(() => setFull(order))
      .finally(() => setLoading(false));
  }, [orderId]);

  const o = full || order;
  if (!o) return <Empty icon="?" title="Objednávka nenájdená" sub="" />;

  const lines = o.lines || [];
  const dur = o.starts_at && o.stops_at ? Math.ceil((new Date(o.stops_at)-new Date(o.starts_at))/(86400000)) : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={() => nav("orders")}>← Späť</Btn>
        <div>
          <span style={{ color: C.t1, fontSize: 18, fontWeight: 700 }}>Objednávka </span>
          <span style={{ color: C.gold, fontSize: 18, fontWeight: 700, fontFamily: C.mono }}>#{o.number}</span>
          <span style={{ marginLeft: 12 }}><Badge status={o.status} /></span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ fontSize: 10, color: C.t3, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 12 }}>DETAILY OBJEDNÁVKY</div>
          {[
            ["Zákazník", o.customer?.name],
            ["Obdobie", o.starts_at ? `${o.starts_at.slice(0,10)} → ${o.stops_at?.slice(0,10)}` : "—"],
            ["Trvanie", dur ? `${dur} dní` : "—"],
            ["Celková suma", o.grand_total_in_cents ? `€${(o.grand_total_in_cents/100).toFixed(2)}` : "—"],
            ["Záloha", o.deposit_in_cents ? `€${(o.deposit_in_cents/100).toFixed(2)}` : "—"],
            ["Poznámka", o.note || "—"],
          ].map(([k,v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
              <span style={{ color: C.t3 }}>{k}</span>
              <span style={{ color: C.t1, maxWidth: "60%", textAlign: "right" }}>{v}</span>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{ fontSize: 10, color: C.t3, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 12 }}>POLOŽKY ({lines.length})</div>
          {loading ? <Spin /> : lines.length === 0 ? <Empty icon="📦" title="Žiadne položky" sub="" /> :
            lines.map(l => (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                <span style={{ color: C.t1 }}>{l.name || l.description}</span>
                <span style={{ color: C.t2, fontFamily: C.mono }}>
                  {l.quantity && `×${l.quantity}`}
                  {l.price_in_cents && ` €${(l.price_in_cents/100).toFixed(2)}`}
                </span>
              </div>
            ))
          }
        </Card>
      </div>

      <Card>
        <div style={{ fontSize: 10, color: C.t3, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 12 }}>AKCIE</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {o.status === "reserved" && <Btn v="orange" onClick={() => nav("picking", o.id)}>→ Spustiť prípravu výdaja</Btn>}
          {o.status === "started" && <Btn v="success" onClick={() => nav("checkin", o.id)}>← Príjem techniky</Btn>}
          <Btn v="ghost" onClick={() => window.open(`https://${CFG.SLUG}.booqable.com/back/orders/${o.id}`, "_blank")}>↗ Otvoriť v Booqable</Btn>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════
// PICKING MODULE — "Príprava výdaja"
// Core feature: step-by-step prep with checklist, issues, barcode
// ═══════════════════════════════════════════════
function PickingModule({ initialOrderId, nav }) {
  const { orders, prepData, savePrepData } = useApp();
  const [selectedId, setSelectedId] = useState(initialOrderId || null);

  const today = new Date().toISOString().slice(0,10);
  const pickOrders = orders
    .filter(o => o.status === "reserved")
    .sort((a,b) => {
      const todayA = a.starts_at?.slice(0,10) === today ? 0 : 1;
      const todayB = b.starts_at?.slice(0,10) === today ? 0 : 1;
      return todayA - todayB || new Date(a.starts_at||0) - new Date(b.starts_at||0);
    });

  if (selectedId) {
    const order = orders.find(o => o.id === selectedId);
    if (order) return <PickingWorkflow order={order} onBack={() => setSelectedId(null)} prepData={prepData} savePrepData={savePrepData} />;
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", color: C.t1, fontSize: 16, fontWeight: 700 }}>Príprava výdaja</h2>
      <p style={{ margin: "0 0 20px", color: C.t2, fontSize: 13 }}>Všetky rezervácie čakajúce na prípravu a výdaj</p>

      {pickOrders.length === 0 ? <Empty icon="🎬" title="Žiadne objednávky na prípravu" sub="Všetky rezervácie sú buď vydané alebo neexistujú" /> :
        <div style={{ display: "grid", gap: 10 }}>
          {pickOrders.map(o => {
            const prep = prepData[o.id] || {};
            const lines = o.lines || [];
            const pickable = lines.filter(l => l.product_id);
            const checked = Object.values(prep.checklist || {}).filter(Boolean).length;
            const pct = pickable.length > 0 ? Math.round((checked / pickable.length) * 100) : 0;
            const isToday = o.starts_at?.slice(0,10) === today;

            return (
              <Card key={o.id} onClick={() => setSelectedId(o.id)} style={{ cursor: "pointer", borderColor: isToday ? `${C.gold}55` : C.border }}
                onMouseEnter={e => e.currentTarget.style.borderColor = C.gold + "88"}
                onMouseLeave={e => e.currentTarget.style.borderColor = isToday ? C.gold + "55" : C.border}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <span style={{ color: C.gold, fontFamily: C.mono, fontWeight: 700, fontSize: 15 }}>#{o.number}</span>
                    {isToday && <span style={{ marginLeft: 8, background: "#181400", color: C.gold, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, border: `1px solid ${C.gold}55` }}>DNES</span>}
                    <div style={{ color: C.t1, fontSize: 14, fontWeight: 600, marginTop: 4 }}>{o.customer?.name || "—"}</div>
                    <div style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>
                      {o.starts_at?.slice(0,10)} → {o.stops_at?.slice(0,10)}
                      {o.grand_total_in_cents && <span style={{ color: C.gold, fontFamily: C.mono, marginLeft: 10 }}>€{(o.grand_total_in_cents/100).toFixed(0)}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <PrepBadge state={prep.state || "pending"} />
                    <div style={{ color: C.t3, fontSize: 11, marginTop: 4 }}>{checked}/{pickable.length} položiek</div>
                  </div>
                </div>
                {pickable.length > 0 && <ProgressBar pct={pct} color={pct === 100 ? C.green : C.gold} />}
              </Card>
            );
          })}
        </div>
      }
    </div>
  );
}

function PickingWorkflow({ order: o, onBack, prepData, savePrepData }) {
  const [orderFull, setOrderFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [scanFeedback, setScanFeedback] = useState(null); // {ok, msg}
  const barcodeRef = useRef();

  const prep = prepData[o.id] || { state: "prepping", checklist: {}, notes: "", issues: [] };
  const lines = (orderFull?.lines || o.lines || []).filter(l => l.product_id || l.name);

  useEffect(() => {
    api.orders.get(o.id)
      .then(d => setOrderFull(d.order || d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [o.id]);

  const save = (patch) => savePrepData({ ...prepData, [o.id]: { ...prep, ...patch } });
  const toggleLine = (id) => {
    const next = { ...prep.checklist, [id]: !prep.checklist[id] };
    const all = lines.length > 0 && lines.every(l => next[l.id]);
    save({ checklist: next, state: all ? "ready" : "prepping" });
  };
  const addIssue = (text) => {
    if (!text.trim()) return;
    save({ issues: [...(prep.issues||[]), { id: Date.now(), text, ts: new Date().toISOString(), resolved: false }], state: "issue" });
  };
  const resolveIssue = (id) => save({ issues: prep.issues.map(i => i.id === id ? { ...i, resolved: true } : i) });

  // Barcode scan — match against line names/SKU
  const handleScan = (val) => {
    const v = val.trim();
    if (!v) return;
    const match = lines.find(l =>
      l.name?.toLowerCase().includes(v.toLowerCase()) ||
      l.sku?.toLowerCase() === v.toLowerCase() ||
      l.barcode === v
    );
    if (match) {
      const next = { ...prep.checklist, [match.id]: true };
      const all = lines.every(l => next[l.id]);
      save({ checklist: next, state: all ? "ready" : "prepping" });
      setScanFeedback({ ok: true, msg: `✓ ${match.name}` });
    } else {
      setScanFeedback({ ok: false, msg: `Nenájdené: "${v}"` });
    }
    setBarcodeInput("");
    setTimeout(() => setScanFeedback(null), 2500);
    barcodeRef.current?.focus();
  };

  const checked = lines.filter(l => prep.checklist[l.id]).length;
  const pct = lines.length > 0 ? Math.round((checked / lines.length) * 100) : 0;
  const allDone = pct === 100 && lines.length > 0;
  const hasOpenIssues = (prep.issues||[]).some(i => !i.resolved);

  const dur = o.starts_at && o.stops_at ? Math.ceil((new Date(o.stops_at)-new Date(o.starts_at))/86400000) : null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={onBack}>← Späť</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: C.t1, fontSize: 18, fontWeight: 700 }}>Príprava výdaja</span>
            <span style={{ color: C.gold, fontFamily: C.mono, fontSize: 18, fontWeight: 700 }}>#{o.number}</span>
            <PrepBadge state={prep.state || "pending"} />
            {hasOpenIssues && <span style={{ color: C.red, fontSize: 12, fontWeight: 700 }}>⚠ Sú otvorené problémy</span>}
          </div>
          <div style={{ color: C.t2, fontSize: 13 }}>{o.customer?.name} · {o.starts_at?.slice(0,10)} → {o.stops_at?.slice(0,10)}{dur ? ` (${dur}d)` : ""}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: C.gold, fontFamily: C.mono, fontSize: 20, fontWeight: 800 }}>{pct}%</div>
          <div style={{ color: C.t3, fontSize: 11 }}>{checked}/{lines.length} položiek</div>
        </div>
      </div>

      <ProgressBar pct={pct} />
      <div style={{ height: 20 }} />

      {/* Scan input */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>🔍 SKENOVANIE / HĽADANIE</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Input
            ref={barcodeRef}
            value={barcodeInput}
            onChange={setBarcodeInput}
            placeholder="Načítaj čiarový kód alebo zadaj názov / SKU…"
            style={{ flex: 1 }}
          />
          <Btn v="primary" onClick={() => handleScan(barcodeInput)}>Potvrď</Btn>
        </div>
        {scanFeedback && (
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 7, background: scanFeedback.ok ? "#001510" : "#1a0808", color: scanFeedback.ok ? C.green : C.red, fontSize: 13, fontWeight: 600 }}>
            {scanFeedback.msg}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 11, color: C.t3 }}>
          Tip: Pripoj USB barcode scanner — automaticky skúša pri stlačení Enter
        </div>
        <input
          ref={barcodeRef}
          style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
          onKeyDown={e => { if (e.key === "Enter") { handleScan(barcodeInput); } }}
          onChange={e => setBarcodeInput(e.target.value)}
          value={barcodeInput}
        />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16 }}>
        {/* Checklist */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em" }}>ZOZNAM TECHNIKY</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn v="ghost" onClick={() => save({ checklist: Object.fromEntries(lines.map(l => [l.id, true])), state: "ready" })}>✓ Označiť všetko</Btn>
              <Btn v="ghost" onClick={() => save({ checklist: {}, state: "prepping" })}>○ Reset</Btn>
            </div>
          </div>

          {loading ? <Spin /> : lines.length === 0 ? <Empty icon="📦" title="Žiadne položky" sub="Booqable nemá položky na tejto objednávke" /> :
            lines.map(l => {
              const done = !!prep.checklist[l.id];
              return (
                <div key={l.id} onClick={() => toggleLine(l.id)} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "11px 10px", borderBottom: `1px solid ${C.border}`,
                  cursor: "pointer", borderRadius: 6, transition: "background .1s",
                }}
                  onMouseEnter={e => e.currentTarget.style.background = C.s2}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <div style={{
                    width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                    border: `2px solid ${done ? C.green : C.border}`,
                    background: done ? C.green : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, color: "#000", fontWeight: 900, transition: "all .2s",
                  }}>{done ? "✓" : ""}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, color: done ? C.t3 : C.t1, textDecoration: done ? "line-through" : "none", fontWeight: done ? 400 : 500 }}>
                      {l.name || l.description || "Položka"}
                    </div>
                    <div style={{ fontSize: 11, color: C.t3, marginTop: 1 }}>
                      {l.quantity && <span style={{ marginRight: 8 }}>×{l.quantity}</span>}
                      {l.sku && <span style={{ fontFamily: C.mono, marginRight: 8 }}>{l.sku}</span>}
                      {l.price_in_cents && <span style={{ fontFamily: C.mono }}>€{(l.price_in_cents/100).toFixed(2)}</span>}
                    </div>
                  </div>
                  {done && <span style={{ fontSize: 12, color: C.green }}>✓</span>}
                </div>
              );
            })
          }

          {allDone && !hasOpenIssues && (
            <div style={{ margin: "16px 0 0", background: "#001510", border: `1px solid ${C.green}55`, borderRadius: 8, padding: "14px 16px", color: C.green, fontSize: 14, fontWeight: 600, textAlign: "center" }}>
              ✓ Všetka technika skontrolovaná — objednávka pripravená na výdaj
            </div>
          )}
        </Card>

        {/* Right panel: notes + issues */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Notes */}
          <Card>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>📝 INTERNÉ POZNÁMKY</div>
            <textarea
              value={prep.notes || ""}
              onChange={e => save({ notes: e.target.value })}
              placeholder="Poznámky k príprave, špeciálne požiadavky…"
              style={{
                width: "100%", boxSizing: "border-box",
                background: C.s2, border: `1px solid ${C.border}`,
                borderRadius: 7, padding: "10px 12px", color: C.t1,
                fontSize: 13, resize: "vertical", minHeight: 80,
                outline: "none", fontFamily: C.font,
              }}
            />
          </Card>

          {/* Issue tracker */}
          <Card style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>⚠ PROBLÉMY / CHÝBAJÚCA TECHNIKA</div>
            <IssueTracker issues={prep.issues || []} onAdd={addIssue} onResolve={resolveIssue} />
          </Card>

          {/* Confirmation */}
          <Card style={{ background: allDone && !hasOpenIssues ? "#001510" : C.s1, borderColor: allDone && !hasOpenIssues ? `${C.green}55` : C.border }}>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>ZÁVEREČNÉ POTVRDENIE</div>
            <div style={{ fontSize: 13, color: C.t2, marginBottom: 12 }}>
              Pred výdajom skontroluj:<br />
              {[
                { label: "Všetka technika odškrtnutá", ok: allDone },
                { label: "Žiadne otvorené problémy", ok: !hasOpenIssues },
                { label: "Zákazník informovaný", ok: false },
              ].map(item => (
                <div key={item.label} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                  <span style={{ color: item.ok ? C.green : C.t3, fontSize: 14 }}>{item.ok ? "✓" : "○"}</span>
                  <span style={{ color: item.ok ? C.t1 : C.t3 }}>{item.label}</span>
                </div>
              ))}
            </div>
            <Btn
              v={allDone && !hasOpenIssues ? "success" : "ghost"}
              disabled={!allDone || hasOpenIssues}
              onClick={() => { save({ state: "ready", completedAt: new Date().toISOString() }); alert("Objednávka označená ako pripravená. Teraz môžete vydať techniku v Booqable."); }}
              style={{ width: "100%" }}
            >
              {allDone && !hasOpenIssues ? "✓ Potvrdiť výdaj" : "Najprv dokonči prípravu"}
            </Btn>
          </Card>
        </div>
      </div>
    </div>
  );
}

function IssueTracker({ issues, onAdd, onResolve }) {
  const [text, setText] = useState("");
  const open = issues.filter(i => !i.resolved);
  const resolved = issues.filter(i => i.resolved);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Input value={text} onChange={setText} placeholder="Popíš problém…" style={{ flex: 1, fontSize: 12 }} />
        <Btn v="danger" onClick={() => { onAdd(text); setText(""); }} disabled={!text.trim()}>+ Pridaj</Btn>
      </div>
      {open.length === 0 && resolved.length === 0 && <div style={{ color: C.t3, fontSize: 12 }}>Žiadne problémy — výborne!</div>}
      {open.map(i => (
        <div key={i.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.red, fontSize: 14, marginTop: 1 }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: C.t1 }}>{i.text}</div>
            <div style={{ fontSize: 10, color: C.t3 }}>{new Date(i.ts).toLocaleTimeString("sk-SK")}</div>
          </div>
          <Btn v="success" onClick={() => onResolve(i.id)} style={{ fontSize: 11, padding: "4px 8px" }}>Vyriešené</Btn>
        </div>
      ))}
      {resolved.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: C.t3, marginBottom: 6 }}>Vyriešené ({resolved.length})</div>
          {resolved.map(i => (
            <div key={i.id} style={{ fontSize: 12, color: C.t3, padding: "4px 0", textDecoration: "line-through" }}>{i.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// CHECK-IN MODULE — "Príjem vrátenia"
// ═══════════════════════════════════════════════
function CheckinModule({ initialOrderId, nav }) {
  const { orders } = useApp();
  const [selectedId, setSelectedId] = useState(initialOrderId || null);

  const active = orders.filter(o => o.status === "started")
    .sort((a,b) => new Date(a.stops_at||0) - new Date(b.stops_at||0));

  if (selectedId) {
    const order = orders.find(o => o.id === selectedId);
    if (order) return <CheckinWorkflow order={order} onBack={() => setSelectedId(null)} />;
  }

  const today = new Date().toISOString().slice(0,10);

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", color: C.t1, fontSize: 16, fontWeight: 700 }}>Príjem vrátenia</h2>
      <p style={{ margin: "0 0 20px", color: C.t2, fontSize: 13 }}>Kontrola a príjem vrátenej techniky</p>

      {active.length === 0 ? <Empty icon="✅" title="Žiadna technika vonku" sub="Všetky objednávky sú vrátené" /> :
        <div style={{ display: "grid", gap: 10 }}>
          {active.map(o => {
            const isToday = o.stops_at?.slice(0,10) === today;
            const isLate = o.stops_at && o.stops_at.slice(0,10) < today;
            return (
              <Card key={o.id} onClick={() => setSelectedId(o.id)} style={{ cursor: "pointer", borderColor: isLate ? `${C.red}55` : isToday ? `${C.green}44` : C.border }}
                onMouseEnter={e => e.currentTarget.style.borderColor = C.green + "88"}
                onMouseLeave={e => e.currentTarget.style.borderColor = isLate ? C.red+"55" : isToday ? C.green+"44" : C.border}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                      <span style={{ color: C.gold, fontFamily: C.mono, fontWeight: 700, fontSize: 15 }}>#{o.number}</span>
                      {isLate && <span style={{ background: "#1a0808", color: C.red, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, border: `1px solid ${C.red}55` }}>MEŠKÁ</span>}
                      {isToday && !isLate && <span style={{ background: "#001510", color: C.green, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, border: `1px solid ${C.green}55` }}>DNES</span>}
                    </div>
                    <div style={{ color: C.t1, fontWeight: 600 }}>{o.customer?.name || "—"}</div>
                    <div style={{ color: C.t3, fontSize: 12 }}>Vrátenie: {o.stops_at?.slice(0,10)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {o.grand_total_in_cents && <div style={{ color: C.gold, fontFamily: C.mono }}> €{(o.grand_total_in_cents/100).toFixed(0)}</div>}
                    <div style={{ color: C.t3, fontSize: 11 }}>{(o.lines||[]).filter(l=>l.product_id).length} položiek →</div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      }
    </div>
  );
}

function CheckinWorkflow({ order: o, onBack }) {
  const [orderFull, setOrderFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checks, setChecks] = useState(() => LS.get(`fs_checkin_${o.id}`, {}));
  const [damages, setDamages] = useState(() => LS.get(`fs_dmg_${o.id}`, []));
  const [dmgText, setDmgText] = useState("");
  const [notes, setNotes] = useState(() => LS.get(`fs_cnotes_${o.id}`, ""));

  useEffect(() => {
    api.orders.get(o.id)
      .then(d => setOrderFull(d.order || d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [o.id]);

  const lines = (orderFull?.lines || o.lines || []).filter(l => l.product_id || l.name);

  const saveChecks = (v) => { setChecks(v); LS.set(`fs_checkin_${o.id}`, v); };
  const saveDamages = (v) => { setDamages(v); LS.set(`fs_dmg_${o.id}`, v); };
  const saveNotes = (v) => { setNotes(v); LS.set(`fs_cnotes_${o.id}`, v); };

  const CHECK_ITEMS = [
    { id: "all_returned", label: "Všetka technika fyzicky vrátená a spočítaná" },
    { id: "no_damage", label: "Vizuálna kontrola — žiadne viditeľné poškodenie" },
    { id: "cables", label: "Káble, adaptéry a príslušenstvo kompletné" },
    { id: "batteries", label: "Batérie a nabíjačky vrátené" },
    { id: "media", label: "CFexpress / SD karty vymazané a vrátené" },
    { id: "cases", label: "Prepravné kufre a tašky v poriadku" },
    { id: "cleaned", label: "Technika čistá (šošovky, body)" },
    { id: "tested", label: "Základná funkčná kontrola vykonaná" },
  ];

  const checked = Object.values(checks).filter(Boolean).length;
  const allChecked = CHECK_ITEMS.every(i => checks[i.id]);
  const pct = Math.round((checked / CHECK_ITEMS.length) * 100);

  const addDamage = () => {
    if (!dmgText.trim()) return;
    const next = [...damages, { id: Date.now(), text: dmgText, ts: new Date().toISOString() }];
    saveDamages(next); setDmgText("");
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={onBack}>← Späť</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: C.t1, fontSize: 18, fontWeight: 700 }}>Príjem vrátenia</span>
            <span style={{ color: C.gold, fontFamily: C.mono, fontSize: 18, fontWeight: 700 }}>#{o.number}</span>
          </div>
          <div style={{ color: C.t2, fontSize: 13 }}>{o.customer?.name} · mal sa vrátiť {o.stops_at?.slice(0,10)}</div>
        </div>
        <div style={{ color: C.t2, fontSize: 13 }}>{pct}% kontroly</div>
      </div>

      <ProgressBar pct={pct} color={C.green} />
      <div style={{ height: 20 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Equipment checklist */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>FYZICKÁ KONTROLA POLOŽIEK</div>
          {loading ? <Spin /> : lines.length === 0 ? <div style={{ color: C.t3, fontSize: 13 }}>Žiadne položky v systéme</div> :
            lines.map(l => (
              <div key={l.id} onClick={() => saveChecks({ ...checks, [`item_${l.id}`]: !checks[`item_${l.id}`] })}
                style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = C.s2}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checks[`item_${l.id}`] ? C.green : C.border}`, background: checks[`item_${l.id}`] ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#000", fontWeight: 900 }}>
                  {checks[`item_${l.id}`] ? "✓" : ""}
                </div>
                <div>
                  <div style={{ fontSize: 13, color: checks[`item_${l.id}`] ? C.t3 : C.t1, textDecoration: checks[`item_${l.id}`] ? "line-through" : "none" }}>{l.name}</div>
                  {l.quantity && <div style={{ fontSize: 11, color: C.t3 }}>×{l.quantity}</div>}
                </div>
              </div>
            ))
          }
        </Card>

        {/* Quality checklist */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>KONTROLNÝ PROTOKOL</div>
          {CHECK_ITEMS.map(item => (
            <div key={item.id} onClick={() => saveChecks({ ...checks, [item.id]: !checks[item.id] })}
              style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = C.s2}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checks[item.id] ? C.green : C.border}`, background: checks[item.id] ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#000", fontWeight: 900 }}>
                {checks[item.id] ? "✓" : ""}
              </div>
              <div style={{ fontSize: 13, color: checks[item.id] ? C.t3 : C.t1, textDecoration: checks[item.id] ? "line-through" : "none" }}>{item.label}</div>
            </div>
          ))}
        </Card>

        {/* Damage report */}
        <Card style={{ borderColor: damages.length > 0 ? `${C.red}55` : C.border }}>
          <div style={{ fontSize: 11, color: damages.length > 0 ? C.red : C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>
            🔴 POŠKODENIA A INCIDENTY {damages.length > 0 && `(${damages.length})`}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <Input value={dmgText} onChange={setDmgText} placeholder="Popíš poškodenie…" style={{ flex: 1, fontSize: 12 }} />
            <Btn v="danger" onClick={addDamage} disabled={!dmgText.trim()}>Zaznamenaj</Btn>
          </div>
          {damages.length === 0
            ? <div style={{ color: C.t3, fontSize: 12 }}>✓ Žiadne poškodenia</div>
            : damages.map(d => (
              <div key={d.id} style={{ display: "flex", gap: 8, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.red }}>⚠</span>
                <div>
                  <div style={{ fontSize: 13, color: C.t1 }}>{d.text}</div>
                  <div style={{ fontSize: 10, color: C.t3 }}>{new Date(d.ts).toLocaleString("sk-SK")}</div>
                </div>
              </div>
            ))
          }
        </Card>

        {/* Final confirm */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>📝 POZNÁMKY K PRÍJMU</div>
          <textarea
            value={notes}
            onChange={e => saveNotes(e.target.value)}
            placeholder="Interné poznámky k príjmu…"
            style={{ width: "100%", boxSizing: "border-box", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 7, padding: "10px 12px", color: C.t1, fontSize: 13, resize: "vertical", minHeight: 80, outline: "none", fontFamily: C.font, marginBottom: 12 }}
          />
          <div style={{ marginBottom: 12 }}>
            {[
              { label: "Všetky položky skontrolované", ok: lines.length > 0 && lines.every(l => checks[`item_${l.id}`]) },
              { label: "Kontrolný protokol dokončený", ok: allChecked },
              { label: "Poškodenia zaznamenané", ok: true },
            ].map(item => (
              <div key={item.label} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span style={{ color: item.ok ? C.green : C.t3 }}>{item.ok ? "✓" : "○"}</span>
                <span style={{ fontSize: 13, color: item.ok ? C.t1 : C.t2 }}>{item.label}</span>
              </div>
            ))}
          </div>
          <Btn v={allChecked ? "success" : "ghost"} disabled={!allChecked}
            onClick={() => {
              LS.set(`fs_checkin_done_${o.id}`, { ts: new Date().toISOString(), damages });
              alert(`Príjem objednávky #${o.number} zaznamenaný.${damages.length > 0 ? `\n⚠ ${damages.length} poškodenie(í) zaznamenané!` : "\n✓ Žiadne poškodenia."}\n\nVráťte objednávku v Booqable.`);
            }}
            style={{ width: "100%" }}
          >
            {allChecked ? "✓ Potvrdiť príjem" : "Dokonči kontrolu"}
          </Btn>
        </Card>
      </div>
    </div>
  );
}

// ── INVENTORY ───────────────────────────────────
function Inventory() {
  const { products, loading } = useApp();
  const [q, setQ] = useState("");
  const filtered = products.filter(p => !q || (p.name||"").toLowerCase().includes(q.toLowerCase()) || (p.sku||"").toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <Input value={q} onChange={setQ} placeholder="Hľadaj techniku, SKU…" style={{ width: "100%", boxSizing: "border-box", marginBottom: 16 }} />
      {loading ? <Spin /> : filtered.length === 0 ? <Empty icon="🎥" title="Žiadna technika" sub="" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
          {filtered.map(p => (
            <Card key={p.id} style={{ padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.t1, marginBottom: 4 }}>{p.name}</div>
              {p.sku && <div style={{ fontSize: 11, color: C.t3, fontFamily: C.mono, marginBottom: 8 }}>{p.sku}</div>}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: C.t2 }}>{p.base_price_in_cents ? `€${(p.base_price_in_cents/100).toFixed(0)}/${p.price_period||"d"}` : ""}</span>
                <span style={{ color: p.stock_count > 0 ? C.green : C.t3 }}>
                  {p.stock_count != null ? `${p.stock_count}×` : ""}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── CUSTOMERS ──────────────────────────────────
function Customers() {
  const { customers, orders, loading } = useApp();
  const [q, setQ] = useState("");
  const enriched = customers.map(c => ({
    ...c,
    orderCount: orders.filter(o => o.customer?.id === c.id || o.customer_id === c.id).length,
    spent: orders.filter(o => (o.customer?.id===c.id||o.customer_id===c.id) && o.status!=="canceled").reduce((s,o)=>s+(o.grand_total_in_cents||0),0)/100,
  })).sort((a,b) => b.spent - a.spent);
  const filtered = enriched.filter(c => !q || (c.name||"").toLowerCase().includes(q.toLowerCase()) || (c.email||"").toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <Input value={q} onChange={setQ} placeholder="Hľadaj zákazníka, email…" style={{ width: "100%", boxSizing: "border-box", marginBottom: 16 }} />
      <Card style={{ padding: 0 }}>
        {loading ? <Spin /> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Zákazník","Email","Telefón","Objednávky","Útrata"].map(h => <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: C.t3, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}
                  onMouseEnter={e => e.currentTarget.style.background = C.s2}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <td style={{ padding: "11px 16px", color: C.t1, fontWeight: 500 }}>{c.name || "—"}{c.company && <div style={{ fontSize: 11, color: C.t3 }}>{c.company}</div>}</td>
                  <td style={{ padding: "11px 16px", color: C.t2 }}>{c.email || "—"}</td>
                  <td style={{ padding: "11px 16px", color: C.t2, fontFamily: C.mono, fontSize: 12 }}>{c.phone || "—"}</td>
                  <td style={{ padding: "11px 16px", color: C.t1 }}>{c.orderCount}</td>
                  <td style={{ padding: "11px 16px", color: c.spent > 0 ? C.gold : C.t3, fontFamily: C.mono }}>{c.spent > 0 ? `€${c.spent.toFixed(2)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ── STATS ──────────────────────────────────────
function Stats() {
  const { orders, products } = useApp();
  const now = new Date();
  const months = Array.from({length:6},(_,i)=>{
    const d = new Date(now.getFullYear(), now.getMonth()-(5-i), 1);
    return { key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label: d.toLocaleString("sk-SK",{month:"short"}), rev:0, cnt:0 };
  });
  orders.forEach(o => {
    if (!o.starts_at||o.status==="canceled") return;
    const k = o.starts_at.slice(0,7);
    const m = months.find(m=>m.key===k);
    if (m) { m.rev += (o.grand_total_in_cents||0)/100; m.cnt++; }
  });
  const maxRev = Math.max(...months.map(m=>m.rev),1);
  const totalRev = orders.filter(o=>o.status!=="canceled").reduce((s,o)=>s+(o.grand_total_in_cents||0),0)/100;
  const statusCounts = Object.keys(STATUS_MAP).map(s=>({ s, count:orders.filter(o=>o.status===s).length })).filter(x=>x.count>0);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          { label:"Celkové tržby", v:`€${totalRev.toFixed(0)}`, c:C.gold },
          { label:"Objednávok", v:orders.length, c:C.t1 },
          { label:"Priem. hodnota", v:orders.length?`€${(totalRev/orders.length).toFixed(0)}`:"—", c:C.t1 },
          { label:"Produktov", v:products.length, c:C.t1 },
        ].map(k=>(
          <Card key={k.label} style={{ flex:1, minWidth:120, textAlign:"center" }}>
            <div style={{ fontSize:26,fontWeight:800,color:k.c,lineHeight:1 }}>{k.v}</div>
            <div style={{ fontSize:11,color:C.t3,marginTop:6,textTransform:"uppercase",letterSpacing:"0.06em" }}>{k.label}</div>
          </Card>
        ))}
      </div>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
        <Card>
          <div style={{ fontSize:11,color:C.t3,fontWeight:700,letterSpacing:"0.08em",marginBottom:20 }}>TRŽBY — 6 MESIACOV</div>
          <div style={{ display:"flex",alignItems:"flex-end",gap:8,height:120 }}>
            {months.map(m=>(
              <div key={m.key} style={{ flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6 }}>
                <div style={{ fontSize:10,color:C.t3,fontFamily:C.mono }}>{m.rev>0?`€${m.rev.toFixed(0)}`:""}</div>
                <div style={{ width:"100%",background:m.rev>0?C.gold:C.border,borderRadius:"3px 3px 0 0",height:`${(m.rev/maxRev)*90}px`,minHeight:m.rev>0?4:2,transition:"height .3s" }} />
                <div style={{ fontSize:10,color:C.t3 }}>{m.label}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <div style={{ fontSize:11,color:C.t3,fontWeight:700,letterSpacing:"0.08em",marginBottom:14 }}>STAV OBJEDNÁVOK</div>
          {statusCounts.map(({s,count})=>{
            const sc=STATUS_MAP[s]; const pct=orders.length?(count/orders.length*100).toFixed(0):0;
            return (
              <div key={s} style={{ marginBottom:10 }}>
                <div style={{ display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4 }}>
                  <span style={{ color:sc.color }}>{sc.label}</span>
                  <span style={{ color:C.t3 }}>{count} ({pct}%)</span>
                </div>
                <div style={{ background:C.border,borderRadius:3,height:4,overflow:"hidden" }}>
                  <div style={{ width:`${pct}%`,height:"100%",background:sc.color,borderRadius:3,opacity:.7 }} />
                </div>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

// ── CALENDAR ───────────────────────────────────
function Calendar() {
  const { orders } = useApp();
  const [cur, setCur] = useState(new Date(new Date().getFullYear(),new Date().getMonth(),1));
  const today = new Date();
  const daysInMonth = new Date(cur.getFullYear(),cur.getMonth()+1,0).getDate();
  const firstDay = (new Date(cur.getFullYear(),cur.getMonth(),1).getDay()+6)%7;
  const getDayOrders = d => {
    const ds = new Date(cur.getFullYear(),cur.getMonth(),d).toISOString().slice(0,10);
    return orders.filter(o=>{
      if(!o.starts_at||!o.stops_at) return false;
      return ds>=o.starts_at.slice(0,10)&&ds<=o.stops_at.slice(0,10);
    });
  };
  return (
    <div>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
        <Btn v="ghost" onClick={()=>setCur(new Date(cur.getFullYear(),cur.getMonth()-1,1))}>‹</Btn>
        <h2 style={{ margin:0,color:C.t1,fontSize:16,fontWeight:700 }}>{cur.toLocaleString("sk-SK",{month:"long",year:"numeric"})}</h2>
        <Btn v="ghost" onClick={()=>setCur(new Date(cur.getFullYear(),cur.getMonth()+1,1))}>›</Btn>
      </div>
      <Card>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:8 }}>
          {["Po","Ut","St","Št","Pi","So","Ne"].map(d=><div key={d} style={{ textAlign:"center",fontSize:11,color:C.t3,fontWeight:700,padding:"4px 0" }}>{d}</div>)}
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2 }}>
          {Array.from({length:firstDay}).map((_,i)=><div key={`e${i}`}/>)}
          {Array.from({length:daysInMonth},(_,i)=>i+1).map(day=>{
            const dos = getDayOrders(day);
            const isToday = today.getDate()===day&&today.getMonth()===cur.getMonth()&&today.getFullYear()===cur.getFullYear();
            const active=dos.filter(o=>o.status==="started").length;
            const res=dos.filter(o=>o.status==="reserved").length;
            return (
              <div key={day} style={{ background:isToday?C.goldGlow:C.s2,border:`1px solid ${isToday?C.gold:C.border}`,borderRadius:6,padding:"6px 5px",minHeight:56 }}>
                <div style={{ fontSize:12,fontWeight:isToday?700:400,color:isToday?C.gold:C.t2,marginBottom:3 }}>{day}</div>
                {active>0&&<div style={{ fontSize:10,background:"#180c00",color:C.orange,borderRadius:3,padding:"1px 4px",marginBottom:2 }}>{active} vyd.</div>}
                {res>0&&<div style={{ fontSize:10,background:"#181400",color:C.gold,borderRadius:3,padding:"1px 4px" }}>{res} rez.</div>}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════
const MODULES = [
  { id:"dashboard",  label:"Dashboard",      icon:"◉",  desc:"Prehľad dňa" },
  { id:"orders",     label:"Objednávky",     icon:"📋", desc:"Všetky objednávky" },
  { id:"picking",    label:"Výdaj",          icon:"→",  desc:"Príprava a vydanie" },
  { id:"checkin",    label:"Príjem",         icon:"←",  desc:"Kontrola vrátenej techniky" },
  { id:"inventory",  label:"Inventár",       icon:"🎥", desc:"Technika" },
  { id:"customers",  label:"Zákazníci",      icon:"👥", desc:"Databáza zákazníkov" },
  { id:"calendar",   label:"Kalendár",       icon:"📅", desc:"Mesačný pohľad" },
  { id:"stats",      label:"Štatistiky",     icon:"📊", desc:"Reporty a prehľady" },
];

function Nav({ active, onNav, orders }) {
  const today = new Date().toISOString().slice(0,10);
  const badges = {
    picking: orders.filter(o=>o.status==="reserved"&&o.starts_at?.slice(0,10)===today).length,
    checkin: orders.filter(o=>o.status==="started"&&o.stops_at?.slice(0,10)===today).length,
  };
  const overdue = orders.filter(o=>o.status==="started"&&o.stops_at&&o.stops_at.slice(0,10)<today).length;

  return (
    <div style={{ width:210,flexShrink:0,background:C.s0,borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",height:"100vh",position:"sticky",top:0 }}>
      <div style={{ padding:"20px 18px 16px",borderBottom:`1px solid ${C.border}` }}>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <div style={{ width:32,height:32,borderRadius:8,background:C.gold,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:900,color:"#000" }}>FS</div>
          <div>
            <div style={{ fontSize:14,fontWeight:800,color:C.t1,letterSpacing:"-0.02em" }}>FilmSupport</div>
            <div style={{ fontSize:9,color:C.t3,letterSpacing:"0.08em",textTransform:"uppercase" }}>RENTAL OS</div>
          </div>
        </div>
      </div>

      {overdue > 0 && (
        <div onClick={() => onNav("checkin")} style={{ margin:"10px 12px 0",background:"#120808",border:`1px solid ${C.red}55`,borderRadius:8,padding:"8px 12px",cursor:"pointer" }}>
          <div style={{ fontSize:11,color:C.red,fontWeight:700 }}>⚠ {overdue} meškajúce</div>
        </div>
      )}

      <nav style={{ flex:1,padding:"10px 8px",overflowY:"auto" }}>
        {MODULES.map(m=>{
          const a = active===m.id;
          const b = badges[m.id];
          return (
            <button key={m.id} onClick={()=>onNav(m.id)} style={{
              display:"flex",alignItems:"center",justifyContent:"space-between",
              width:"100%",padding:"9px 10px",borderRadius:8,marginBottom:2,
              background:a?C.goldGlow:"transparent",
              border:`1px solid ${a?C.gold+"44":"transparent"}`,
              cursor:"pointer",transition:"all .12s",
              color:a?C.gold:C.t2,fontSize:13,fontWeight:a?700:400,textAlign:"left",
            }}
              onMouseEnter={e=>{if(!a)e.currentTarget.style.background=C.s2}}
              onMouseLeave={e=>{if(!a)e.currentTarget.style.background="transparent"}}
            >
              <span><span style={{ marginRight:9,fontSize:14 }}>{m.icon}</span>{m.label}</span>
              {b>0&&<span style={{ background:C.gold,color:"#000",borderRadius:10,padding:"1px 6px",fontSize:10,fontWeight:800 }}>{b}</span>}
            </button>
          );
        })}
      </nav>

      <div style={{ padding:"12px 14px",borderTop:`1px solid ${C.border}`,fontSize:10,color:C.t3 }}>
        <div>Booqable API v1/v4</div>
        <div style={{ marginTop:2 }}>filmsupport-d93f</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════
function App() {
  const [route, setRoute] = useState({ module: "dashboard", id: null });

  const nav = useCallback((module, id = null) => setRoute({ module, id }), []);

  return (
    <AppProvider>
      <AppInner route={route} nav={nav} />
    </AppProvider>
  );
}

function AppInner({ route, nav }) {
  const { orders, loading } = useApp();
  const mod = MODULES.find(m=>m.id===route.module);

  const renderModule = () => {
    switch(route.module) {
      case "dashboard":    return <Dashboard nav={nav} />;
      case "orders":       return <OrdersList nav={nav} />;
      case "order_detail": return <OrderDetail orderId={route.id} nav={nav} />;
      case "picking":      return <PickingModule initialOrderId={route.id} nav={nav} />;
      case "checkin":      return <CheckinModule initialOrderId={route.id} nav={nav} />;
      case "inventory":    return <Inventory />;
      case "customers":    return <Customers />;
      case "calendar":     return <Calendar />;
      case "stats":        return <Stats />;
      default:             return <Dashboard nav={nav} />;
    }
  };

  return (
    <div style={{ display:"flex",minHeight:"100vh",background:C.bg,color:C.t1,fontFamily:C.font,fontSize:14 }}>
      <Nav active={route.module} onNav={m=>nav(m)} orders={orders} />
      <div style={{ flex:1,overflow:"auto" }}>
        <div style={{ borderBottom:`1px solid ${C.border}`,padding:"14px 24px",background:C.s0,position:"sticky",top:0,zIndex:10,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
          <div style={{ fontSize:15,fontWeight:700,color:C.t1 }}>{mod?.icon} {mod?.label}</div>
          <div style={{ fontSize:11,color:C.t3 }}>{new Date().toLocaleDateString("sk-SK",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</div>
        </div>
        <div style={{ padding:24,maxWidth:1400 }}>{renderModule()}</div>
      </div>
    </div>
  );
}

export default App;
