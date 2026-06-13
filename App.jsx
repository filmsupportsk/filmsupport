import { useState, useEffect, useCallback, createContext, useContext, useRef } from "react";

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const CFG = {
  SLUG: "filmsupport-d93f",
  KEY: "b4fa0a2776238d680da685ac37fa7a9047551017d4bba65792b4a1987ae699db",
  V1: "https://filmsupport-d93f.booqable.com/api/1",
};

// ═══════════════════════════════════════════════
// API LAYER — corrected with proper filtering & pagination
// ═══════════════════════════════════════════════
const api = {
  async req(path, opts = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${CFG.V1}${path}${sep}api_key=${CFG.KEY}`;
    const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },

  // Load ALL pages of a specific status filter
  async loadAllByStatus(statuses) {
    const results = [];
    for (const status of statuses) {
      let page = 1;
      while (true) {
        const data = await api.req(`/orders?per=100&filter[status]=${status}&page=${page}`);
        const orders = data.orders || [];
        results.push(...orders);
        const meta = data.meta || {};
        const totalPages = Math.ceil((meta.total_count || 0) / 100);
        if (page >= totalPages || orders.length === 0) break;
        page++;
      }
    }
    return results;
  },

  // Load recent orders (last N pages sorted newest first via last pages)
  async loadRecent(count = 200) {
    const firstData = await api.req(`/orders?per=1`);
    const total = firstData.meta?.total_count || 0;
    if (total === 0) return [];

    const perPage = 100;
    const totalPages = Math.ceil(total / perPage);
    const pagesToFetch = Math.ceil(count / perPage);
    const results = [];

    const pagePromises = [];
    for (let i = 0; i < pagesToFetch; i++) {
      const page = totalPages - i;
      if (page < 1) break;
      pagePromises.push(api.req(`/orders?per=${perPage}&page=${page}`));
    }

    const responses = await Promise.all(pagePromises);
    for (const data of responses) {
      results.push(...(data.orders || []));
    }
    // Sort newest first
    results.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return results;
  },

  // Get meta stats (total counts per status)
  async getMeta() {
    const data = await api.req(`/orders?per=1`);
    return data.meta || {};
  },

  orders: {
    get: (id) => api.req(`/orders/${id}`),
    update: (id, body) => api.req(`/orders/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  },
  customers: {
    list: () => api.req("/customers?per=200"),
    getRecent: async () => {
      const d = await api.req("/customers?per=1");
      const total = d.meta?.total_count || 0;
      const pages = Math.ceil(total / 100);
      const last = await api.req(`/customers?per=100&page=${pages}`);
      return { customers: last.customers || [], total };
    }
  },
  products: {
    list: () => api.req("/product_groups?per=200"),
  },
};

// ═══════════════════════════════════════════════
// TOKENS
// ═══════════════════════════════════════════════
const C = {
  bg: "#070709", s0: "#0d0d12", s1: "#111118", s2: "#16161e", s3: "#1c1c27",
  border: "#222230", borderHi: "#2e2e40",
  gold: "#e8c84a", goldDim: "#b89a30", goldGlow: "rgba(232,200,74,0.10)",
  red: "#e05555", green: "#3fd68a", blue: "#4a8fe8", orange: "#e8894a", purple: "#9b6ee8",
  t1: "#f0eee8", t2: "#9090a8", t3: "#505060",
  font: "'Inter', system-ui, sans-serif", mono: "'JetBrains Mono', monospace",
};

const STATUS_MAP = {
  new:      { label: "Nová",        color: C.t3,     bg: "#111118" },
  draft:    { label: "Draft",       color: C.purple, bg: "#0e0c18" },
  concept:  { label: "Koncept",     color: C.blue,   bg: "#0c1520" },
  reserved: { label: "Rezervovaná", color: C.gold,   bg: "#181400" },
  started:  { label: "Vydaná",      color: C.orange, bg: "#180c00" },
  stopped:  { label: "Vrátená",     color: C.green,  bg: "#001510" },
  archived: { label: "Archív",      color: C.t3,     bg: "#111118" },
  canceled: { label: "Zrušená",     color: C.red,    bg: "#180a0a" },
};

const LS = {
  get: (k, def = null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ═══════════════════════════════════════════════
// APP CONTEXT — proper multi-phase loading
// ═══════════════════════════════════════════════
const Ctx = createContext(null);

function AppProvider({ children }) {
  // Active orders (started + reserved + concept + draft) — loaded immediately
  const [activeOrders, setActiveOrders] = useState([]);
  // Recent orders — last 200 by date
  const [recentOrders, setRecentOrders] = useState([]);
  // Meta stats from API
  const [meta, setMeta] = useState({});
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [customerTotal, setCustomerTotal] = useState(0);

  const [loadingActive, setLoadingActive] = useState(true);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [error, setError] = useState(null);
  const [synced, setSynced] = useState(null);
  const [prepData, setPrepData] = useState(() => LS.get("fs_prep", {}));

  const savePrepData = useCallback((next) => { setPrepData(next); LS.set("fs_prep", next); }, []);

  // Phase 1: Load active orders + meta immediately
  const loadActive = useCallback(async () => {
    setLoadingActive(true);
    try {
      const [activeData, metaData] = await Promise.all([
        api.loadAllByStatus(["started", "reserved", "concept", "draft", "new"]),
        api.getMeta(),
      ]);
      setActiveOrders(activeData.sort((a, b) => new Date(b.starts_at || 0) - new Date(a.starts_at || 0)));
      setMeta(metaData);
      setSynced(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingActive(false);
    }
  }, []);

  // Phase 2: Load recent orders (last 200)
  const loadRecent = useCallback(async () => {
    setLoadingRecent(true);
    try {
      const recent = await api.loadRecent(200);
      setRecentOrders(recent);
    } catch (e) {
      console.error("Recent load error:", e);
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  // Phase 3: Load customers + products
  const loadSupport = useCallback(async () => {
    setLoadingCustomers(true);
    setLoadingProducts(true);
    try {
      const [custData, prodData] = await Promise.all([
        api.customers.getRecent(),
        api.products.list(),
      ]);
      setCustomers(custData.customers);
      setCustomerTotal(custData.total);
      setProducts(prodData.product_groups || []);
    } catch (e) {
      console.error("Support load error:", e);
    } finally {
      setLoadingCustomers(false);
      setLoadingProducts(false);
    }
  }, []);

  const syncAll = useCallback(async () => {
    setError(null);
    await loadActive();
    await Promise.all([loadRecent(), loadSupport()]);
  }, [loadActive, loadRecent, loadSupport]);

  useEffect(() => {
    loadActive();
    loadRecent();
    loadSupport();
  }, []);

  // All orders for views that need everything
  const allOrders = [...activeOrders, ...recentOrders.filter(o =>
    !["started","reserved","concept","draft","new"].includes(o.status)
  )];

  return (
    <Ctx.Provider value={{
      activeOrders, recentOrders, allOrders, meta,
      customers, customerTotal, products,
      loadingActive, loadingRecent, loadingCustomers, loadingProducts,
      error, synced, syncAll, prepData, savePrepData,
    }}>
      {children}
    </Ctx.Provider>
  );
}
const useApp = () => useContext(Ctx);

// ═══════════════════════════════════════════════
// UI ATOMS
// ═══════════════════════════════════════════════
function Badge({ status }) {
  const s = STATUS_MAP[status] || STATUS_MAP.new;
  return <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}44`, borderRadius: 4, padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{s.label}</span>;
}
function Card({ children, style = {}, onClick }) {
  return <div onClick={onClick} style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, ...style, cursor: onClick ? "pointer" : "default" }}
    onMouseEnter={e => onClick && (e.currentTarget.style.borderColor = C.borderHi)}
    onMouseLeave={e => onClick && (e.currentTarget.style.borderColor = C.border)}
  >{children}</div>;
}
function Spin({ size = 28 }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
    <div style={{ width: size, height: size, borderRadius: "50%", border: `2px solid ${C.border}`, borderTopColor: C.gold, animation: "spin .7s linear infinite" }} />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>;
}
function Empty({ icon, title, sub }) {
  return <div style={{ textAlign: "center", padding: "40px 16px", color: C.t3 }}><div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div><div style={{ color: C.t2, fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{title}</div>{sub && <div style={{ fontSize: 12 }}>{sub}</div>}</div>;
}
function Btn({ children, onClick, v = "ghost", disabled = false, style = {} }) {
  const vars = { primary: { background: C.gold, color: "#000", border: "none" }, ghost: { background: C.s2, color: C.t2, border: `1px solid ${C.border}` }, danger: { background: "#1a0808", color: C.red, border: `1px solid ${C.red}44` }, success: { background: "#001510", color: C.green, border: `1px solid ${C.green}44` }, orange: { background: "#180c00", color: C.orange, border: `1px solid ${C.orange}44` } };
  return <button onClick={onClick} disabled={disabled} style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, fontWeight: 600, fontFamily: C.font, borderRadius: 7, padding: "7px 14px", fontSize: 12, transition: "all .15s", ...vars[v], ...style }}>{children}</button>;
}
function Input({ value, onChange, placeholder, style = {} }) {
  return <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.t1, fontSize: 13, outline: "none", fontFamily: C.font, ...style }} />;
}
function ProgressBar({ pct, color = C.gold }) {
  return <div style={{ background: C.border, borderRadius: 4, height: 5, overflow: "hidden" }}><div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: pct >= 100 ? C.green : color, borderRadius: 4, transition: "width .3s" }} /></div>;
}
function LoadingDot({ loading }) {
  if (!loading) return null;
  return <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: C.gold, marginLeft: 6, animation: "pulse 1s ease infinite" }}>
    <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
  </span>;
}

// ═══════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════
function Dashboard({ nav }) {
  const { activeOrders, recentOrders, meta, customerTotal, loadingActive, loadingRecent, error, synced, syncAll } = useApp();
  const today = new Date().toISOString().slice(0, 10);

  const started   = activeOrders.filter(o => o.status === "started");
  const reserved  = activeOrders.filter(o => o.status === "reserved");
  const concept   = activeOrders.filter(o => ["concept","draft","new"].includes(o.status));
  const goingOut  = reserved.filter(o => o.starts_at?.slice(0,10) === today);
  const returning = started.filter(o => o.stops_at?.slice(0,10) === today);
  const overdue   = started.filter(o => o.stops_at && o.stops_at.slice(0,10) < today);

  // Revenue from meta or calculate from recent
  const totalRevCents = meta.sum_amount_in_cents ||
    recentOrders.filter(o => o.status !== "canceled").reduce((s, o) => s + (o.grand_total_in_cents || 0), 0);
  const totalRev = totalRevCents / 100;

  const statuses = meta.statuses || {};

  const kpis = [
    { label: "Vonku práve teraz", value: loadingActive ? "…" : started.length, color: C.orange, click: () => nav("orders", null, "started") },
    { label: "Dnes vychádza", value: loadingActive ? "…" : goingOut.length, color: C.gold, click: () => nav("picking") },
    { label: "Dnes vracia", value: loadingActive ? "…" : returning.length, color: C.green, click: () => nav("checkin") },
    { label: "Rezervácie", value: loadingActive ? "…" : reserved.length, color: C.blue, click: () => nav("orders", null, "reserved") },
    { label: "Zákazníci", value: customerTotal || "…", color: C.t1 },
    { label: "Tržby celkom", value: totalRev > 0 ? `€${Math.round(totalRev).toLocaleString("sk-SK")}` : "…", color: C.gold },
  ];

  return (
    <div>
      {error && <div style={{ background: "#1a0808", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 16px", color: C.red, fontSize: 13, marginBottom: 16 }}>⚠ {error}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, color: C.t1, fontSize: 16, fontWeight: 700 }}>Prehľad dňa</h2>
          {loadingActive && <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>Načítavajú sa aktívne objednávky…</div>}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {synced && <span style={{ fontSize: 11, color: C.t3 }}>sync {synced.toLocaleTimeString("sk-SK")}</span>}
          <Btn onClick={syncAll} v="ghost">↺ Sync</Btn>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        {kpis.map(k => (
          <Card key={k.label} onClick={k.click} style={{ textAlign: "center", padding: "18px 12px" }}>
            <div style={{ fontSize: 30, fontWeight: 800, color: k.color, lineHeight: 1 }}>{k.value}<LoadingDot loading={loadingActive && k.value === "…"} /></div>
            <div style={{ fontSize: 11, color: C.t3, marginTop: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k.label}</div>
          </Card>
        ))}
      </div>

      {/* Status breakdown from meta */}
      {Object.keys(statuses).length > 0 && (
        <Card style={{ marginBottom: 16, padding: "14px 18px" }}>
          <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>BOOQABLE — STAV VŠETKÝCH OBJEDNÁVOK ({Object.values(statuses).reduce((a,b)=>a+b,0).toLocaleString()})</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {Object.entries(statuses).map(([status, count]) => {
              const s = STATUS_MAP[status];
              if (!s || !count) return null;
              return <div key={status} style={{ fontSize: 12 }}>
                <span style={{ color: s.color, fontWeight: 700 }}>{count.toLocaleString()}</span>
                <span style={{ color: C.t3, marginLeft: 4 }}>{s.label}</span>
              </div>;
            })}
          </div>
        </Card>
      )}

      {/* Today panels */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ fontSize: 12, color: C.gold, fontWeight: 700, marginBottom: 12 }}>→ DNES VYCHÁDZA ({goingOut.length})</div>
          {loadingActive ? <Spin size={20} /> : goingOut.length === 0
            ? <Empty icon="📅" title="Nič na dnes" sub="Žiadne vydania naplánované" />
            : goingOut.map(o => <OrderRowSmall key={o.id} order={o} onClick={() => nav("picking", o.id)} />)}
        </Card>
        <Card>
          <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 12 }}>← DNES VRACIA ({returning.length})</div>
          {loadingActive ? <Spin size={20} /> : returning.length === 0
            ? <Empty icon="✅" title="Nič sa nevracia" sub="" />
            : returning.map(o => <OrderRowSmall key={o.id} order={o} onClick={() => nav("checkin", o.id)} />)}
        </Card>
      </div>

      {/* Overdue */}
      {overdue.length > 0 && (
        <Card style={{ borderColor: `${C.red}55`, background: "#120808", marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 12 }}>⚠ MEŠKAJÚ — NEVRÁTENÁ TECHNIKA ({overdue.length})</div>
          {overdue.map(o => (
            <div key={o.id} onClick={() => nav("checkin", o.id)} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13, cursor: "pointer" }}>
              <span><span style={{ color: C.gold, fontFamily: C.mono }}>#{o.number}</span> · <span style={{ color: C.t1 }}>{o.customer?.name || "—"}</span></span>
              <span style={{ color: C.red, fontFamily: C.mono, fontSize: 11 }}>malo vrátiť {o.stops_at?.slice(0,10)}</span>
            </div>
          ))}
        </Card>
      )}

      {/* Active orders full list */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em" }}>
            AKTÍVNE OBJEDNÁVKY ({started.length + reserved.length + concept.length})
            <LoadingDot loading={loadingActive} />
          </div>
          <Btn v="ghost" onClick={() => nav("orders")} style={{ fontSize: 11 }}>Všetky →</Btn>
        </div>
        {loadingActive ? <Spin size={20} /> : activeOrders.length === 0
          ? <Empty icon="📋" title="Žiadne aktívne objednávky" sub="" />
          : <OrderTable orders={activeOrders.slice(0, 15)} onSelect={o => nav("order_detail", o.id)} />
        }
      </Card>

      {/* Recent orders */}
      <Card style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em" }}>
            POSLEDNÉ OBJEDNÁVKY
            <LoadingDot loading={loadingRecent} />
          </div>
        </div>
        {loadingRecent && recentOrders.length === 0 ? <Spin size={20} /> :
          <OrderTable orders={recentOrders.slice(0, 10)} onSelect={o => nav("order_detail", o.id)} />
        }
      </Card>
    </div>
  );
}

function OrderRowSmall({ order: o, onClick }) {
  return (
    <div onClick={onClick} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}`, cursor: onClick ? "pointer" : "default" }}>
      <div>
        <span style={{ color: C.gold, fontFamily: C.mono, fontSize: 12, fontWeight: 700 }}>#{o.number}</span>
        <span style={{ color: C.t1, fontSize: 13, marginLeft: 8 }}>{o.customer?.name || "—"}</span>
      </div>
      <Badge status={o.status} />
    </div>
  );
}

function OrderTable({ orders, onSelect }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            {["#", "Zákazník", "Od", "Do", "Status", "Suma", ""].map(h => (
              <th key={h} style={{ padding: "8px 14px", textAlign: "left", color: C.t3, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map(o => (
            <tr key={o.id} onClick={() => onSelect?.(o)} style={{ borderBottom: `1px solid ${C.border}`, cursor: onSelect ? "pointer" : "default", transition: "background .1s" }}
              onMouseEnter={e => e.currentTarget.style.background = C.s2}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <td style={{ padding: "10px 14px", color: C.gold, fontFamily: C.mono, fontWeight: 700 }}>#{o.number}</td>
              <td style={{ padding: "10px 14px", color: C.t1, maxWidth: 160 }}>{o.customer?.name || <span style={{ color: C.t3 }}>—</span>}</td>
              <td style={{ padding: "10px 14px", color: C.t2, fontFamily: C.mono, fontSize: 11 }}>{o.starts_at?.slice(0,10) || "—"}</td>
              <td style={{ padding: "10px 14px", color: C.t2, fontFamily: C.mono, fontSize: 11 }}>{o.stops_at?.slice(0,10) || "—"}</td>
              <td style={{ padding: "10px 14px" }}><Badge status={o.status} /></td>
              <td style={{ padding: "10px 14px", color: C.t1, fontFamily: C.mono }}>{o.grand_total_in_cents ? `€${(o.grand_total_in_cents/100).toFixed(0)}` : "—"}</td>
              <td style={{ padding: "10px 14px", color: C.t3 }}>{onSelect ? "›" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ORDERS LIST — with filters and search
// ═══════════════════════════════════════════════
function OrdersList({ nav, initialStatus }) {
  const { activeOrders, recentOrders, loadingActive, loadingRecent } = useApp();
  const [q, setQ] = useState("");
  const [st, setSt] = useState(initialStatus || "all");
  const [source, setSource] = useState("active"); // active | recent | all

  // Pick data source based on filter
  const baseOrders = source === "active" ? activeOrders
    : source === "recent" ? recentOrders
    : [...activeOrders, ...recentOrders.filter(o => !["started","reserved","concept","draft","new"].includes(o.status))];

  const list = baseOrders.filter(o => {
    const ms = st === "all" || o.status === st;
    const mq = !q || String(o.number).includes(q) || (o.customer?.name || "").toLowerCase().includes(q.toLowerCase());
    return ms && mq;
  }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const loading = source === "active" ? loadingActive : loadingRecent;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <Input value={q} onChange={setQ} placeholder="Hľadaj číslo, zákazník…" style={{ flex: 1, minWidth: 180 }} />
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {["all","started","reserved","concept","stopped","canceled"].map(s => (
            <button key={s} onClick={() => { setSt(s); setSource(["started","reserved","concept","draft","new","all"].includes(s) ? "all" : "recent"); }}
              style={{ background: st===s ? C.gold : C.s2, color: st===s ? "#000" : C.t2, border: `1px solid ${st===s ? C.gold : C.border}`, borderRadius: 6, padding: "5px 11px", fontSize: 11, cursor: "pointer", fontWeight: st===s ? 700 : 400 }}>
              {s === "all" ? "Všetky" : STATUS_MAP[s]?.label || s}
            </button>
          ))}
        </div>
      </div>

      {/* Source toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: C.t3 }}>Zdroj:</span>
        {[["active", "Aktívne (started/reserved)"], ["recent", "Posledných 200"], ["all", "Aktívne + Posledných 200"]].map(([k, l]) => (
          <button key={k} onClick={() => setSource(k)} style={{ background: source===k ? C.s3 : "transparent", color: source===k ? C.t1 : C.t3, border: `1px solid ${source===k ? C.borderHi : "transparent"}`, borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>{l}</button>
        ))}
        {loading && <Spin size={14} />}
      </div>

      <Card style={{ padding: 0 }}>
        {loading && list.length === 0 ? <Spin /> : list.length === 0
          ? <Empty icon="🔍" title="Žiadne výsledky" sub="Zmeňte filter alebo hľadanie" />
          : <OrderTable orders={list} onSelect={o => nav("order_detail", o.id)} />
        }
      </Card>
      <div style={{ color: C.t3, fontSize: 11, marginTop: 8 }}>{list.length} objednávok zobrazených</div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ORDER DETAIL
// ═══════════════════════════════════════════════
function OrderDetail({ orderId, nav }) {
  const { activeOrders, recentOrders } = useApp();
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const cached = [...activeOrders, ...recentOrders].find(o => o.id === orderId);

  useEffect(() => {
    api.orders.get(orderId)
      .then(d => setFull(d.order || d))
      .catch(() => setFull(cached))
      .finally(() => setLoading(false));
  }, [orderId]);

  const o = full || cached;
  if (!o && loading) return <Spin />;
  if (!o) return <Empty icon="?" title="Objednávka nenájdená" sub="" />;

  const lines = o.lines || [];
  const dur = o.starts_at && o.stops_at ? Math.ceil((new Date(o.stops_at)-new Date(o.starts_at))/86400000) : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={() => nav("orders")}>← Späť</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: C.t1, fontSize: 18, fontWeight: 700 }}>Objednávka </span>
            <span style={{ color: C.gold, fontFamily: C.mono, fontSize: 18, fontWeight: 700 }}>#{o.number}</span>
            <Badge status={o.status} />
          </div>
          <div style={{ color: C.t2, fontSize: 13 }}>{o.customer?.name}</div>
        </div>
        <Btn v="ghost" onClick={() => window.open(`https://${CFG.SLUG}.booqable.com/back/orders/${o.id}`, "_blank")}>↗ Booqable</Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ fontSize: 10, color: C.t3, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 12 }}>DETAILY</div>
          {[
            ["Zákazník", o.customer?.name],
            ["Telefón", o.customer?.phone],
            ["Email", o.customer?.email],
            ["Od", o.starts_at?.slice(0,16).replace("T"," ")],
            ["Do", o.stops_at?.slice(0,16).replace("T"," ")],
            ["Trvanie", dur ? `${dur} dní` : "—"],
            ["Suma", o.grand_total_in_cents ? `€${(o.grand_total_in_cents/100).toFixed(2)}` : "—"],
            ["Záloha", o.deposit_in_cents ? `€${(o.deposit_in_cents/100).toFixed(2)}` : "—"],
            ["Štítky", o.tag_list?.join(", ") || "—"],
            ["Poznámka", o.note || "—"],
          ].map(([k, v]) => v && (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
              <span style={{ color: C.t3 }}>{k}</span>
              <span style={{ color: C.t1, maxWidth: "60%", textAlign: "right", wordBreak: "break-all" }}>{v}</span>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{ fontSize: 10, color: C.t3, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 12 }}>POLOŽKY ({lines.length})</div>
          {loading ? <Spin size={20} /> : lines.length === 0
            ? <Empty icon="📦" title="Žiadne položky" sub="" />
            : lines.map(l => (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                <span style={{ color: C.t1 }}>{l.name || l.description || "Položka"}</span>
                <span style={{ color: C.t2, fontFamily: C.mono, fontSize: 11 }}>
                  {l.quantity && `×${l.quantity}`}{l.price_in_cents ? ` €${(l.price_in_cents/100).toFixed(2)}` : ""}
                </span>
              </div>
            ))
          }
        </Card>
      </div>

      <Card>
        <div style={{ fontSize: 10, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>AKCIE</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {o.status === "reserved" && <Btn v="orange" onClick={() => nav("picking", o.id)}>→ Spustiť prípravu výdaja</Btn>}
          {o.status === "started"  && <Btn v="success" onClick={() => nav("checkin", o.id)}>← Príjem techniky</Btn>}
          <Btn v="ghost" onClick={() => window.open(`https://${CFG.SLUG}.booqable.com/back/orders/${o.id}`, "_blank")}>↗ Otvoriť v Booqable</Btn>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════
// PICKING MODULE
// ═══════════════════════════════════════════════
function PickingModule({ initialOrderId, nav }) {
  const { activeOrders, prepData, savePrepData, loadingActive } = useApp();
  const [selectedId, setSelectedId] = useState(initialOrderId || null);

  const today = new Date().toISOString().slice(0,10);
  const pickOrders = activeOrders
    .filter(o => ["reserved", "concept", "draft"].includes(o.status))
    .sort((a,b) => {
      const ta = a.starts_at?.slice(0,10) === today ? 0 : 1;
      const tb = b.starts_at?.slice(0,10) === today ? 0 : 1;
      return ta - tb || new Date(a.starts_at||0) - new Date(b.starts_at||0);
    });

  if (selectedId) {
    const order = activeOrders.find(o => o.id === selectedId);
    if (order) return <PickingWorkflow order={order} onBack={() => setSelectedId(null)} prepData={prepData} savePrepData={savePrepData} />;
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", color: C.t1, fontSize: 16, fontWeight: 700 }}>Príprava výdaja</h2>
      <p style={{ margin: "0 0 20px", color: C.t2, fontSize: 13 }}>Rezervácie čakajúce na prípravu a výdaj</p>
      {loadingActive ? <Spin /> : pickOrders.length === 0
        ? <Empty icon="🎬" title="Žiadne objednávky na prípravu" sub="Všetky rezervácie sú vydané alebo neexistujú" />
        : <div style={{ display: "grid", gap: 10 }}>
          {pickOrders.map(o => {
            const prep = prepData[o.id] || {};
            const lines = (o.lines || []).filter(l => l.product_id);
            const checked = Object.values(prep.checklist || {}).filter(Boolean).length;
            const pct = lines.length > 0 ? Math.round((checked/lines.length)*100) : 0;
            const isToday = o.starts_at?.slice(0,10) === today;
            return (
              <Card key={o.id} onClick={() => setSelectedId(o.id)} style={{ cursor: "pointer", borderColor: isToday ? `${C.gold}55` : C.border }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                  <div>
                    <span style={{ color: C.gold, fontFamily: C.mono, fontWeight: 700, fontSize: 15 }}>#{o.number}</span>
                    {isToday && <span style={{ marginLeft: 8, background: "#181400", color: C.gold, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, border: `1px solid ${C.gold}55` }}>DNES</span>}
                    <div style={{ color: C.t1, fontSize: 14, fontWeight: 600, marginTop: 4 }}>{o.customer?.name || "—"}</div>
                    <div style={{ color: C.t3, fontSize: 12, marginTop: 2 }}>{o.starts_at?.slice(0,10)} → {o.stops_at?.slice(0,10)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <Badge status={o.status} />
                    <div style={{ color: C.t3, fontSize: 11, marginTop: 4 }}>{checked}/{lines.length} položiek</div>
                  </div>
                </div>
                {lines.length > 0 && <ProgressBar pct={pct} />}
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
  const [loadingFull, setLoadingFull] = useState(true);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [scanFeedback, setScanFeedback] = useState(null);
  const barcodeRef = useRef();

  const prep = prepData[o.id] || { state: "prepping", checklist: {}, notes: "", issues: [] };
  const lines = (orderFull?.lines || o.lines || []).filter(l => l.product_id || l.name);

  useEffect(() => {
    api.orders.get(o.id)
      .then(d => setOrderFull(d.order || d))
      .catch(() => {})
      .finally(() => setLoadingFull(false));
  }, [o.id]);

  const save = (patch) => savePrepData({ ...prepData, [o.id]: { ...prep, ...patch } });
  const toggleLine = (id) => {
    const next = { ...prep.checklist, [id]: !prep.checklist[id] };
    save({ checklist: next, state: lines.every(l => next[l.id]) ? "ready" : "prepping" });
  };

  const handleScan = (val) => {
    const v = val.trim();
    if (!v) return;
    const match = lines.find(l => l.name?.toLowerCase().includes(v.toLowerCase()) || l.sku?.toLowerCase() === v.toLowerCase());
    if (match) {
      const next = { ...prep.checklist, [match.id]: true };
      save({ checklist: next, state: lines.every(l => next[l.id]) ? "ready" : "prepping" });
      setScanFeedback({ ok: true, msg: `✓ ${match.name}` });
    } else {
      setScanFeedback({ ok: false, msg: `Nenájdené: "${v}"` });
    }
    setBarcodeInput("");
    setTimeout(() => setScanFeedback(null), 2500);
    barcodeRef.current?.focus();
  };

  const checked = lines.filter(l => prep.checklist[l.id]).length;
  const pct = lines.length > 0 ? Math.round((checked/lines.length)*100) : 0;
  const allDone = pct === 100 && lines.length > 0;
  const hasOpenIssues = (prep.issues||[]).some(i => !i.resolved);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={onBack}>← Späť</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.t1 }}>Príprava výdaja <span style={{ color: C.gold, fontFamily: C.mono }}>#{o.number}</span></div>
          <div style={{ color: C.t2, fontSize: 13 }}>{o.customer?.name} · {o.starts_at?.slice(0,10)} → {o.stops_at?.slice(0,10)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: C.gold, fontFamily: C.mono, fontSize: 22, fontWeight: 800 }}>{pct}%</div>
          <div style={{ color: C.t3, fontSize: 11 }}>{checked}/{lines.length}</div>
        </div>
      </div>
      <ProgressBar pct={pct} />
      <div style={{ height: 16 }} />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>🔍 SKENER / HĽADANIE</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Input ref={barcodeRef} value={barcodeInput} onChange={setBarcodeInput} placeholder="Barcode, SKU alebo názov…" style={{ flex: 1 }} />
          <Btn v="primary" onClick={() => handleScan(barcodeInput)}>Potvrď</Btn>
        </div>
        {scanFeedback && <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 7, background: scanFeedback.ok ? "#001510" : "#1a0808", color: scanFeedback.ok ? C.green : C.red, fontSize: 13, fontWeight: 600 }}>{scanFeedback.msg}</div>}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em" }}>TECHNIKA ({lines.length})</div>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn v="ghost" onClick={() => save({ checklist: Object.fromEntries(lines.map(l=>[l.id,true])), state: "ready" })}>✓ Všetko</Btn>
              <Btn v="ghost" onClick={() => save({ checklist: {}, state: "prepping" })}>Reset</Btn>
            </div>
          </div>
          {loadingFull ? <Spin size={20} /> : lines.length === 0
            ? <Empty icon="📦" title="Žiadne položky" sub="" />
            : lines.map(l => {
              const done = !!prep.checklist[l.id];
              return (
                <div key={l.id} onClick={() => toggleLine(l.id)} style={{ display: "flex", gap: 12, padding: "10px 8px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", borderRadius: 6 }}
                  onMouseEnter={e => e.currentTarget.style.background = C.s2}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${done ? C.green : C.border}`, background: done ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#000", fontWeight: 900, flexShrink: 0 }}>{done ? "✓" : ""}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: done ? C.t3 : C.t1, textDecoration: done ? "line-through" : "none" }}>{l.name || "Položka"}</div>
                    <div style={{ fontSize: 11, color: C.t3 }}>{l.quantity && `×${l.quantity}`}{l.sku && ` · ${l.sku}`}{l.price_in_cents && ` · €${(l.price_in_cents/100).toFixed(2)}`}</div>
                  </div>
                </div>
              );
            })
          }
          {allDone && !hasOpenIssues && <div style={{ marginTop: 14, background: "#001510", border: `1px solid ${C.green}55`, borderRadius: 8, padding: "12px 16px", color: C.green, fontSize: 14, fontWeight: 600, textAlign: "center" }}>✓ Všetká technika skontrolovaná — pripravené na výdaj</div>}
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>📝 POZNÁMKY</div>
            <textarea value={prep.notes || ""} onChange={e => save({ notes: e.target.value })} placeholder="Poznámky k príprave…" style={{ width: "100%", boxSizing: "border-box", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 7, padding: "10px 12px", color: C.t1, fontSize: 13, resize: "vertical", minHeight: 80, outline: "none", fontFamily: C.font }} />
          </Card>
          <Card style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>⚠ PROBLÉMY</div>
            <IssueTracker issues={prep.issues||[]}
              onAdd={(t) => save({ issues: [...(prep.issues||[]), { id: Date.now(), text: t, ts: new Date().toISOString(), resolved: false }], state: "issue" })}
              onResolve={(id) => save({ issues: prep.issues.map(i => i.id===id ? {...i, resolved:true} : i) })}
            />
          </Card>
          <Card style={{ background: allDone && !hasOpenIssues ? "#001510" : C.s1, borderColor: allDone && !hasOpenIssues ? `${C.green}55` : C.border }}>
            <Btn v={allDone && !hasOpenIssues ? "success" : "ghost"} disabled={!allDone || hasOpenIssues}
              onClick={() => { save({ state: "ready", completedAt: new Date().toISOString() }); alert(`Objednávka #${o.number} pripravená na výdaj!\n\nVydajte techniku v Booqable a zmeňte status na "Started".`); }}
              style={{ width: "100%" }}>
              {allDone && !hasOpenIssues ? "✓ Potvrdiť — pripravené na výdaj" : `Dokonči prípravu (${checked}/${lines.length})`}
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
  const done = issues.filter(i => i.resolved);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <Input value={text} onChange={setText} placeholder="Popíš problém…" style={{ flex: 1, fontSize: 12 }} />
        <Btn v="danger" onClick={() => { onAdd(text); setText(""); }} disabled={!text.trim()}>+</Btn>
      </div>
      {open.length === 0 && done.length === 0 && <div style={{ color: C.t3, fontSize: 12 }}>Žiadne problémy ✓</div>}
      {open.map(i => (
        <div key={i.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.red }}>⚠</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: C.t1 }}>{i.text}</div>
            <div style={{ fontSize: 10, color: C.t3 }}>{new Date(i.ts).toLocaleTimeString("sk-SK")}</div>
          </div>
          <Btn v="success" onClick={() => onResolve(i.id)} style={{ fontSize: 11, padding: "3px 8px" }}>✓</Btn>
        </div>
      ))}
      {done.length > 0 && <div style={{ marginTop: 8 }}>{done.map(i => <div key={i.id} style={{ fontSize: 12, color: C.t3, textDecoration: "line-through", padding: "2px 0" }}>{i.text}</div>)}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// CHECKIN MODULE
// ═══════════════════════════════════════════════
function CheckinModule({ initialOrderId, nav }) {
  const { activeOrders, loadingActive } = useApp();
  const [selectedId, setSelectedId] = useState(initialOrderId || null);
  const today = new Date().toISOString().slice(0,10);

  const active = activeOrders.filter(o => o.status === "started")
    .sort((a,b) => new Date(a.stops_at||0) - new Date(b.stops_at||0));

  if (selectedId) {
    const order = activeOrders.find(o => o.id === selectedId);
    if (order) return <CheckinWorkflow order={order} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", color: C.t1, fontSize: 16, fontWeight: 700 }}>Príjem vrátenia</h2>
      <p style={{ margin: "0 0 20px", color: C.t2, fontSize: 13 }}>Kontrola a príjem vrátenej techniky — {active.length} vonku</p>
      {loadingActive ? <Spin /> : active.length === 0
        ? <Empty icon="✅" title="Žiadna technika vonku" sub="Všetky objednávky sú vrátené" />
        : <div style={{ display: "grid", gap: 10 }}>
          {active.map(o => {
            const isToday = o.stops_at?.slice(0,10) === today;
            const isLate = o.stops_at && o.stops_at.slice(0,10) < today;
            return (
              <Card key={o.id} onClick={() => setSelectedId(o.id)} style={{ cursor: "pointer", borderColor: isLate ? `${C.red}55` : isToday ? `${C.green}44` : C.border }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                      <span style={{ color: C.gold, fontFamily: C.mono, fontWeight: 700 }}>#{o.number}</span>
                      {isLate && <span style={{ background: "#1a0808", color: C.red, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>MEŠKÁ</span>}
                      {isToday && !isLate && <span style={{ background: "#001510", color: C.green, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>DNES</span>}
                    </div>
                    <div style={{ color: C.t1, fontWeight: 600 }}>{o.customer?.name || "—"}</div>
                    <div style={{ color: C.t3, fontSize: 12 }}>Vrátenie: {o.stops_at?.slice(0,10)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {o.grand_total_in_cents && <div style={{ color: C.gold, fontFamily: C.mono }}>€{(o.grand_total_in_cents/100).toFixed(0)}</div>}
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
  const [checks, setChecks] = useState(() => LS.get(`fs_ci_${o.id}`, {}));
  const [damages, setDamages] = useState(() => LS.get(`fs_dmg_${o.id}`, []));
  const [dmgText, setDmgText] = useState("");
  const [notes, setNotes] = useState(() => LS.get(`fs_cn_${o.id}`, ""));

  useEffect(() => {
    api.orders.get(o.id).then(d => setOrderFull(d.order||d)).catch(()=>{}).finally(()=>setLoading(false));
  }, [o.id]);

  const lines = (orderFull?.lines || o.lines || []).filter(l => l.product_id || l.name);
  const saveC = v => { setChecks(v); LS.set(`fs_ci_${o.id}`, v); };
  const saveD = v => { setDamages(v); LS.set(`fs_dmg_${o.id}`, v); };

  const PROTOCOL = [
    { id: "all_returned", label: "Všetka technika fyzicky vrátená a spočítaná" },
    { id: "no_damage", label: "Vizuálna kontrola — žiadne viditeľné poškodenie" },
    { id: "cables", label: "Káble, adaptéry a príslušenstvo kompletné" },
    { id: "batteries", label: "Batérie a nabíjačky vrátené" },
    { id: "media", label: "CFexpress / SD karty vymazané a vrátené" },
    { id: "cases", label: "Prepravné kufre a tašky v poriadku" },
    { id: "cleaned", label: "Technika čistá (šošovky, body)" },
    { id: "tested", label: "Základná funkčná kontrola vykonaná" },
  ];

  const protocolDone = PROTOCOL.every(i => checks[i.id]);
  const itemsDone = lines.length > 0 && lines.every(l => checks[`i_${l.id}`]);
  const pct = Math.round((Object.values(checks).filter(Boolean).length / (PROTOCOL.length + lines.length)) * 100);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={onBack}>← Späť</Btn>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.t1 }}>Príjem vrátenia <span style={{ color: C.gold, fontFamily: C.mono }}>#{o.number}</span></div>
          <div style={{ color: C.t2, fontSize: 13 }}>{o.customer?.name} · vrátenie {o.stops_at?.slice(0,10)}</div>
        </div>
        <div style={{ color: C.t2, fontSize: 13 }}>{pct}%</div>
      </div>
      <ProgressBar pct={pct} color={C.green} />
      <div style={{ height: 16 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>FYZICKÁ KONTROLA POLOŽIEK</div>
          {loading ? <Spin size={20} /> : lines.map(l => (
            <div key={l.id} onClick={() => saveC({...checks, [`i_${l.id}`]: !checks[`i_${l.id}`]})} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = C.s2}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checks[`i_${l.id}`] ? C.green : C.border}`, background: checks[`i_${l.id}`] ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#000", fontWeight: 900 }}>{checks[`i_${l.id}`] ? "✓" : ""}</div>
              <div>
                <div style={{ fontSize: 13, color: checks[`i_${l.id}`] ? C.t3 : C.t1, textDecoration: checks[`i_${l.id}`] ? "line-through" : "none" }}>{l.name}</div>
                {l.quantity && <div style={{ fontSize: 11, color: C.t3 }}>×{l.quantity}</div>}
              </div>
            </div>
          ))}
        </Card>

        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 12 }}>KONTROLNÝ PROTOKOL</div>
          {PROTOCOL.map(item => (
            <div key={item.id} onClick={() => saveC({...checks, [item.id]: !checks[item.id]})} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = C.s2}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${checks[item.id] ? C.green : C.border}`, background: checks[item.id] ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#000", fontWeight: 900 }}>{checks[item.id] ? "✓" : ""}</div>
              <div style={{ fontSize: 13, color: checks[item.id] ? C.t3 : C.t1, textDecoration: checks[item.id] ? "line-through" : "none" }}>{item.label}</div>
            </div>
          ))}
        </Card>

        <Card style={{ borderColor: damages.length > 0 ? `${C.red}55` : C.border }}>
          <div style={{ fontSize: 11, color: damages.length > 0 ? C.red : C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>🔴 POŠKODENIA {damages.length > 0 ? `(${damages.length})` : ""}</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <Input value={dmgText} onChange={setDmgText} placeholder="Popíš poškodenie…" style={{ flex: 1, fontSize: 12 }} />
            <Btn v="danger" onClick={() => { saveD([...damages, { id: Date.now(), text: dmgText, ts: new Date().toISOString() }]); setDmgText(""); }} disabled={!dmgText.trim()}>+</Btn>
          </div>
          {damages.length === 0 ? <div style={{ color: C.t3, fontSize: 12 }}>✓ Žiadne poškodenia</div>
            : damages.map(d => <div key={d.id} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ color: C.red }}>⚠</span><div><div style={{ fontSize: 13, color: C.t1 }}>{d.text}</div><div style={{ fontSize: 10, color: C.t3 }}>{new Date(d.ts).toLocaleString("sk-SK")}</div></div></div>)}
        </Card>

        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 10 }}>ZÁVEREČNÉ POTVRDENIE</div>
          <textarea value={notes} onChange={e => { setNotes(e.target.value); LS.set(`fs_cn_${o.id}`, e.target.value); }} placeholder="Interné poznámky…" style={{ width: "100%", boxSizing: "border-box", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 7, padding: "10px 12px", color: C.t1, fontSize: 13, resize: "vertical", minHeight: 70, outline: "none", fontFamily: C.font, marginBottom: 12 }} />
          {[{ label: "Položky skontrolované", ok: itemsDone }, { label: "Protokol dokončený", ok: protocolDone }, { label: "Poškodenia zaznamenané", ok: true }].map(item => (
            <div key={item.label} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <span style={{ color: item.ok ? C.green : C.t3 }}>{item.ok ? "✓" : "○"}</span>
              <span style={{ fontSize: 13, color: item.ok ? C.t1 : C.t2 }}>{item.label}</span>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <Btn v={protocolDone && itemsDone ? "success" : "ghost"} disabled={!protocolDone || !itemsDone}
              onClick={() => { LS.set(`fs_ci_done_${o.id}`, { ts: new Date().toISOString(), damages }); alert(`Príjem #${o.number} zaznamenaný.${damages.length > 0 ? `\n⚠ ${damages.length} poškodenie(í)!` : "\n✓ Bez poškodení."}\n\nVráťte objednávku v Booqable.`); }}
              style={{ width: "100%" }}>
              {protocolDone && itemsDone ? "✓ Potvrdiť príjem" : "Dokonči kontrolu"}
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════
function Inventory() {
  const { products, loadingProducts } = useApp();
  const [q, setQ] = useState("");
  const filtered = products.filter(p => !q || (p.name||"").toLowerCase().includes(q.toLowerCase()) || (p.sku||"").toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <Input value={q} onChange={setQ} placeholder="Hľadaj techniku, SKU…" style={{ width: "100%", boxSizing: "border-box", marginBottom: 16 }} />
      {loadingProducts ? <Spin /> : filtered.length === 0 ? <Empty icon="🎥" title="Žiadna technika" sub="" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
          {filtered.map(p => (
            <Card key={p.id} style={{ padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.t1, marginBottom: 4 }}>{p.name}</div>
              {p.sku && <div style={{ fontSize: 11, color: C.t3, fontFamily: C.mono, marginBottom: 8 }}>{p.sku}</div>}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: C.t2 }}>{p.base_price_in_cents ? `€${(p.base_price_in_cents/100).toFixed(0)}/${p.price_period||"d"}` : ""}</span>
                <span style={{ color: p.stock_count > 0 ? C.green : C.t3 }}>{p.stock_count != null ? `${p.stock_count}×` : ""}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════
function Customers() {
  const { customers, customerTotal, activeOrders, recentOrders, loadingCustomers } = useApp();
  const [q, setQ] = useState("");
  const allOrders = [...activeOrders, ...recentOrders];
  const enriched = customers.map(c => ({
    ...c,
    orderCount: allOrders.filter(o => o.customer?.id === c.id || o.customer_id === c.id).length,
    spent: allOrders.filter(o => (o.customer?.id===c.id||o.customer_id===c.id) && o.status!=="canceled").reduce((s,o)=>s+(o.grand_total_in_cents||0),0)/100,
  })).sort((a,b) => b.spent - a.spent);
  const filtered = enriched.filter(c => !q || (c.name||"").toLowerCase().includes(q.toLowerCase()) || (c.email||"").toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <Input value={q} onChange={setQ} placeholder="Hľadaj zákazníka, email…" style={{ flex: 1 }} />
        <div style={{ color: C.t3, fontSize: 12, marginLeft: 12 }}>Celkom: {customerTotal.toLocaleString()}</div>
      </div>
      <Card style={{ padding: 0 }}>
        {loadingCustomers ? <Spin /> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Zákazník","Email","Telefón","Objednávky","Útrata"].map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.t3, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}
                  onMouseEnter={e => e.currentTarget.style.background = C.s2}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <td style={{ padding: "10px 14px", color: C.t1, fontWeight: 500 }}>{c.name||"—"}{c.company&&<div style={{fontSize:11,color:C.t3}}>{c.company}</div>}</td>
                  <td style={{ padding: "10px 14px", color: C.t2 }}>{c.email||"—"}</td>
                  <td style={{ padding: "10px 14px", color: C.t2, fontFamily: C.mono, fontSize: 12 }}>{c.phone||"—"}</td>
                  <td style={{ padding: "10px 14px", color: C.t1 }}>{c.orderCount}</td>
                  <td style={{ padding: "10px 14px", color: c.spent > 0 ? C.gold : C.t3, fontFamily: C.mono }}>{c.spent > 0 ? `€${c.spent.toFixed(0)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div style={{ color: C.t3, fontSize: 11, marginTop: 8 }}>Zobrazuje sa posledných {customers.length} z {customerTotal.toLocaleString()} zákazníkov</div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════
function Stats() {
  const { recentOrders, activeOrders, meta, products, loadingRecent } = useApp();
  const allOrders = [...activeOrders, ...recentOrders];
  const statuses = meta.statuses || {};
  const payStatus = meta.payment_status || {};
  const tags = meta.tag_list || {};

  const totalRevCents = allOrders.filter(o=>o.status!=="canceled").reduce((s,o)=>s+(o.grand_total_in_cents||0),0);
  const totalRev = totalRevCents / 100;

  const now = new Date();
  const months = Array.from({length:6},(_,i)=>{
    const d = new Date(now.getFullYear(), now.getMonth()-(5-i), 1);
    return { key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label: d.toLocaleString("sk-SK",{month:"short"}), rev:0, cnt:0 };
  });
  allOrders.forEach(o => {
    if (!o.starts_at || o.status==="canceled") return;
    const k = o.starts_at.slice(0,7);
    const m = months.find(m=>m.key===k);
    if (m) { m.rev += (o.grand_total_in_cents||0)/100; m.cnt++; }
  });
  const maxRev = Math.max(...months.map(m=>m.rev), 1);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* KPIs from meta */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          { l: "Objednávok celkom", v: Object.values(statuses).reduce((a,b)=>a+b,0).toLocaleString() },
          { l: "Vydaných práve teraz", v: (statuses.started||0) },
          { l: "Zaplatených", v: (payStatus.paid||0).toLocaleString() },
          { l: "Nezaplatených", v: (payStatus.payment_due||0).toLocaleString() },
          { l: "Produktov v inventári", v: products.length },
          { l: "Tržby (posledných 200)", v: `€${Math.round(totalRev).toLocaleString("sk-SK")}` },
        ].map(k => (
          <Card key={k.l} style={{ flex: 1, minWidth: 120, textAlign: "center", padding: "16px 12px" }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.gold, lineHeight: 1 }}>{k.v}</div>
            <div style={{ fontSize: 10, color: C.t3, marginTop: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k.l}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Revenue chart */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 20 }}>TRŽBY — POSLEDNÝCH 6 MESIACOV</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
            {months.map(m => (
              <div key={m.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ fontSize: 10, color: C.t3, fontFamily: C.mono }}>{m.rev > 0 ? `€${Math.round(m.rev)}` : ""}</div>
                <div style={{ width: "100%", background: m.rev > 0 ? C.gold : C.border, borderRadius: "3px 3px 0 0", height: `${(m.rev/maxRev)*90}px`, minHeight: m.rev > 0 ? 4 : 2 }} />
                <div style={{ fontSize: 10, color: C.t3 }}>{m.label}</div>
              </div>
            ))}
          </div>
          {loadingRecent && <div style={{ fontSize: 11, color: C.t3, textAlign: "center", marginTop: 8 }}>Načítavajú sa dáta…</div>}
        </Card>

        {/* Status breakdown */}
        <Card>
          <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>STAV VŠETKÝCH OBJEDNÁVOK</div>
          {Object.entries(statuses).map(([s, cnt]) => {
            const sc = STATUS_MAP[s]; if (!sc || !cnt) return null;
            const total = Object.values(statuses).reduce((a,b)=>a+b,0);
            const pct = ((cnt/total)*100).toFixed(0);
            return (
              <div key={s} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: sc.color }}>{sc.label}</span>
                  <span style={{ color: C.t3 }}>{cnt.toLocaleString()} ({pct}%)</span>
                </div>
                <ProgressBar pct={Number(pct)} color={sc.color} />
              </div>
            );
          })}
        </Card>

        {/* Payment status */}
        {Object.keys(payStatus).length > 0 && (
          <Card>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>PLATOBNÝ STAV</div>
            {Object.entries(payStatus).map(([s, cnt]) => {
              const colors = { paid: C.green, payment_due: C.red, partially_paid: C.orange, overpaid: C.purple };
              const labels = { paid: "Zaplatené", payment_due: "Nezaplatené", partially_paid: "Čiastočne", overpaid: "Preplatok" };
              return (
                <div key={s} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                  <span style={{ color: colors[s] || C.t2 }}>{labels[s] || s}</span>
                  <span style={{ color: C.t1, fontFamily: C.mono, fontWeight: 700 }}>{cnt.toLocaleString()}</span>
                </div>
              );
            })}
          </Card>
        )}

        {/* Tags */}
        {Object.keys(tags).length > 0 && (
          <Card>
            <div style={{ fontSize: 11, color: C.t3, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 14 }}>ŠTÍTKY OBJEDNÁVOK</div>
            {Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([tag, cnt]) => (
              <div key={tag} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                <span style={{ color: C.t1 }}>{tag}</span>
                <span style={{ color: C.gold, fontFamily: C.mono }}>{cnt.toLocaleString()}</span>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════
function Calendar() {
  const { activeOrders, recentOrders } = useApp();
  const [cur, setCur] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const today = new Date();
  const daysInMonth = new Date(cur.getFullYear(), cur.getMonth()+1, 0).getDate();
  const firstDay = (new Date(cur.getFullYear(), cur.getMonth(), 1).getDay()+6)%7;
  const allOrders = [...activeOrders, ...recentOrders];

  const getDayOrders = d => {
    const ds = new Date(cur.getFullYear(), cur.getMonth(), d).toISOString().slice(0,10);
    return allOrders.filter(o => {
      if (!o.starts_at||!o.stops_at) return false;
      return ds >= o.starts_at.slice(0,10) && ds <= o.stops_at.slice(0,10);
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <Btn v="ghost" onClick={() => setCur(new Date(cur.getFullYear(), cur.getMonth()-1, 1))}>‹</Btn>
        <h2 style={{ margin: 0, color: C.t1, fontSize: 16, fontWeight: 700 }}>{cur.toLocaleString("sk-SK", {month:"long", year:"numeric"})}</h2>
        <Btn v="ghost" onClick={() => setCur(new Date(cur.getFullYear(), cur.getMonth()+1, 1))}>›</Btn>
      </div>
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 8 }}>
          {["Po","Ut","St","Št","Pi","So","Ne"].map(d => <div key={d} style={{ textAlign: "center", fontSize: 11, color: C.t3, fontWeight: 700, padding: "4px 0" }}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
          {Array.from({length:firstDay}).map((_,i) => <div key={`e${i}`}/>)}
          {Array.from({length:daysInMonth},(_,i)=>i+1).map(day => {
            const dos = getDayOrders(day);
            const isToday = today.getDate()===day && today.getMonth()===cur.getMonth() && today.getFullYear()===cur.getFullYear();
            const active = dos.filter(o=>o.status==="started").length;
            const res = dos.filter(o=>o.status==="reserved").length;
            return (
              <div key={day} style={{ background: isToday ? C.goldGlow : C.s2, border: `1px solid ${isToday ? C.gold : C.border}`, borderRadius: 6, padding: "6px 5px", minHeight: 54 }}>
                <div style={{ fontSize: 12, fontWeight: isToday?700:400, color: isToday?C.gold:C.t2, marginBottom: 3 }}>{day}</div>
                {active > 0 && <div style={{ fontSize: 10, background: "#180c00", color: C.orange, borderRadius: 3, padding: "1px 4px", marginBottom: 2 }}>{active} vyd.</div>}
                {res > 0 && <div style={{ fontSize: 10, background: "#181400", color: C.gold, borderRadius: 3, padding: "1px 4px" }}>{res} rez.</div>}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════
// NAV
// ═══════════════════════════════════════════════
const MODULES = [
  { id:"dashboard",  label:"Dashboard",   icon:"◉" },
  { id:"orders",     label:"Objednávky",  icon:"📋" },
  { id:"picking",    label:"Výdaj",       icon:"→" },
  { id:"checkin",    label:"Príjem",      icon:"←" },
  { id:"inventory",  label:"Inventár",    icon:"🎥" },
  { id:"customers",  label:"Zákazníci",   icon:"👥" },
  { id:"calendar",   label:"Kalendár",    icon:"📅" },
  { id:"stats",      label:"Štatistiky",  icon:"📊" },
];

function Nav({ active, onNav }) {
  const { activeOrders, meta, loadingActive } = useApp();
  const today = new Date().toISOString().slice(0,10);
  const started  = activeOrders.filter(o => o.status === "started").length;
  const reserved = activeOrders.filter(o => o.status === "reserved").length;
  const goingToday = activeOrders.filter(o => o.status==="reserved" && o.starts_at?.slice(0,10)===today).length;
  const returningToday = activeOrders.filter(o => o.status==="started" && o.stops_at?.slice(0,10)===today).length;
  const overdue = activeOrders.filter(o => o.status==="started" && o.stops_at && o.stops_at.slice(0,10)<today).length;
  const badges = { picking: goingToday, checkin: returningToday };

  return (
    <div style={{ width: 210, flexShrink: 0, background: C.s0, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", height: "100vh", position: "sticky", top: 0 }}>
      <div style={{ padding: "20px 18px 16px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: C.gold, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 900, color: "#000" }}>FS</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.t1, letterSpacing: "-0.02em" }}>FilmSupport</div>
            <div style={{ fontSize: 9, color: C.t3, letterSpacing: "0.08em", textTransform: "uppercase" }}>RENTAL OS</div>
          </div>
        </div>
      </div>

      {/* Live status */}
      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", justify: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12 }}>
            <span style={{ color: C.orange, fontWeight: 700 }}>{loadingActive ? "…" : started}</span>
            <span style={{ color: C.t3, marginLeft: 4 }}>vonku</span>
          </div>
          <div style={{ fontSize: 12 }}>
            <span style={{ color: C.gold, fontWeight: 700 }}>{loadingActive ? "…" : reserved}</span>
            <span style={{ color: C.t3, marginLeft: 4 }}>rezerv.</span>
          </div>
          {overdue > 0 && <div style={{ fontSize: 12, width: "100%", marginTop: 4 }}>
            <span style={{ color: C.red, fontWeight: 700 }}>⚠ {overdue}</span>
            <span style={{ color: C.t3, marginLeft: 4 }}>mešká</span>
          </div>}
        </div>
      </div>

      <nav style={{ flex: 1, padding: "10px 8px", overflowY: "auto" }}>
        {MODULES.map(m => {
          const a = active === m.id;
          const b = badges[m.id];
          return (
            <button key={m.id} onClick={() => onNav(m.id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "9px 10px", borderRadius: 8, marginBottom: 2, background: a ? C.goldGlow : "transparent", border: `1px solid ${a ? C.gold+"44" : "transparent"}`, cursor: "pointer", transition: "all .12s", color: a ? C.gold : C.t2, fontSize: 13, fontWeight: a ? 700 : 400, textAlign: "left" }}
              onMouseEnter={e => { if (!a) e.currentTarget.style.background = C.s2; }}
              onMouseLeave={e => { if (!a) e.currentTarget.style.background = "transparent"; }}
            >
              <span><span style={{ marginRight: 9, fontSize: 14 }}>{m.icon}</span>{m.label}</span>
              {b > 0 && <span style={{ background: C.gold, color: "#000", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 800 }}>{b}</span>}
            </button>
          );
        })}
      </nav>

      <div style={{ padding: "12px 14px", borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.t3 }}>
        <div>Booqable API v1</div>
        <div style={{ marginTop: 2 }}>filmsupport-d93f · {(meta.total_count||0).toLocaleString()} obj.</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════
function App() {
  const [route, setRoute] = useState({ module: "dashboard", id: null, extra: null });
  const nav = useCallback((module, id = null, extra = null) => setRoute({ module, id, extra }), []);

  return (
    <AppProvider>
      <AppInner route={route} nav={nav} />
    </AppProvider>
  );
}

function AppInner({ route, nav }) {
  const mod = MODULES.find(m => m.id === route.module);

  const renderModule = () => {
    switch(route.module) {
      case "dashboard":    return <Dashboard nav={nav} />;
      case "orders":       return <OrdersList nav={nav} initialStatus={route.extra} />;
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
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, color: C.t1, fontFamily: C.font, fontSize: 14 }}>
      <Nav active={route.module} onNav={m => nav(m)} />
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ borderBottom: `1px solid ${C.border}`, padding: "14px 24px", background: C.s0, position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.t1 }}>{mod?.icon} {mod?.label}</div>
          <div style={{ fontSize: 11, color: C.t3 }}>{new Date().toLocaleDateString("sk-SK", {weekday:"long", day:"numeric", month:"long", year:"numeric"})}</div>
        </div>
        <div style={{ padding: 24, maxWidth: 1400 }}>{renderModule()}</div>
      </div>
    </div>
  );
}

export default App;
