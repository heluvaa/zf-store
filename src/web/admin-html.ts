/**
 * Panel admin satu halaman: HTML + JS inline, tanpa framework, tanpa asset
 * eksternal. Semua data lewat /api/admin/* dengan x-admin-key dari localStorage.
 * Render selalu lewat esc() — nama produk/pembayaran apa pun tidak boleh bisa
 * menyuntik HTML.
 */
export function adminPanelHtml(brand: string): string {
  const brandSafe = brand
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin · ${brandSafe}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; position: sticky; top: 0; z-index: 2; }
  header h1 { font-size: 16px; margin: 0; flex: 1; }
  main { padding: 12px 16px 80px; max-width: 980px; margin: 0 auto; }
  nav { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  nav button, .btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 7px 13px; font-size: 14px; cursor: pointer; }
  nav button.on { background: #1f6feb; border-color: #1f6feb; }
  .btn.p { background: #238636; border-color: #2ea043; }
  .btn.d { background: #6e2120; border-color: #a5342f; }
  .btn.sm { padding: 4px 9px; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 10px 12px; }
  .card b { display: block; font-size: 18px; margin-top: 2px; }
  .card span { color: #8b949e; font-size: 12px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; font-size: 14px; }
  th, td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { background: #1c2128; font-size: 12px; text-transform: uppercase; color: #8b949e; }
  tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .ok { background: #1a7f37; } .warn { background: #9e6a03; } .bad { background: #b62324; } .mute { background: #30363d; }
  h2 { font-size: 15px; margin: 18px 0 8px; }
  form.panel { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; display: grid; gap: 8px; margin-bottom: 16px; }
  input, textarea, select { width: 100%; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; font: inherit; }
  textarea { min-height: 60px; resize: vertical; }
  label { font-size: 12px; color: #8b949e; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .variant { border: 1px dashed #30363d; border-radius: 8px; padding: 10px; display: grid; gap: 6px; margin-bottom: 6px; }
  #toast { position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); background: #1f6feb; color: #fff; padding: 9px 18px; border-radius: 10px; display: none; max-width: 90vw; word-break: break-word; z-index: 5; }
  #toast.err { background: #b62324; }
  .muted { color: #8b949e; }
  .num { font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) { .row { grid-template-columns: 1fr; } table { font-size: 13px; } th, td { padding: 6px 7px; } }
</style>
</head>
<body>
<header>
  <h1>${brandSafe} · Admin</h1>
  <button class="btn sm" id="btn-savekey">Ganti Kunci</button>
</header>
<main>
  <nav id="tabs"></nav>
  <section id="view"></section>
</main>
<div id="toast"></div>
<script>
(function () {
  "use strict";
  var KEY_LS = "zf_admin_key";
  var key = localStorage.getItem(KEY_LS) || "";

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.className = isErr ? "err" : "";
    t.style.display = "block";
    clearTimeout(toast.h);
    toast.h = setTimeout(function () { t.style.display = "none"; }, 4000);
  }
  function askKey(force) {
    if (key && !force) return true;
    var k = window.prompt("Kunci admin (disimpan di browser ini saja):", key);
    if (k) { key = k.trim(); localStorage.setItem(KEY_LS, key); return true; }
    return false;
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "x-admin-key": key, "content-type": "application/json" }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || body.ok === false) {
          var err = new Error(body.message || body.error || "HTTP " + res.status);
          err.code = body.error;
          throw err;
        }
        return body;
      });
    });
  }
  function post(path, data) { return api(path, { method: "POST", body: JSON.stringify(data) }); }
  function del(path) { return api(path, { method: "DELETE" }); }
  function rp(n) {
    if (n === null || n === undefined) return "-";
    var neg = n < 0; n = Math.abs(Math.trunc(n));
    return (neg ? "-" : "") + "Rp " + String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ".");
  }
  function time(iso) { return iso ? new Date(iso).toLocaleString("id-ID", { hour12: false, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"; }
  var STATUS_PILL = {
    PENDING_PAYMENT: ["warn", "MENUNGGU"], PAID: ["ok", "LUNAS"], DELIVERING: ["warn", "KIRIM"],
    DELIVERED: ["ok", "SELESAI"], EXPIRED: ["mute", "EXPIRED"], CANCELLED: ["mute", "BATAL"], FAILED: ["bad", "GAGAL"]
  };
  function pill(status) {
    var s = STATUS_PILL[status] || ["mute", status];
    return '<span class="pill ' + s[0] + '">' + esc(s[1]) + "</span>";
  }

  var tabs = [
    ["ringkasan", "Ringkasan", renderRingkasan],
    ["katalog", "Katalog", renderKatalog],
    ["stok", "Stok", renderStok],
    ["pesanan", "Pesanan", renderPesanan],
    ["pembayaran", "Pembayaran", renderPembayaran]
  ];
  var current = "ringkasan";
  var nav = document.getElementById("tabs");
  var view = document.getElementById("view");

  function drawTabs() {
    nav.innerHTML = "";
    tabs.forEach(function (t) {
      var b = document.createElement("button");
      b.textContent = t[1];
      if (t[0] === current) b.className = "on";
      b.onclick = function () { current = t[0]; drawTabs(); run(); };
      nav.appendChild(b);
    });
  }
  function run() {
    if (!key) { if (!askKey()) { view.innerHTML = '<p class="muted">Kunci admin belum diisi.</p>'; return; } }
    var found = tabs.filter(function (t) { return t[0] === current; })[0];
    view.innerHTML = '<p class="muted">Memuat…</p>';
    Promise.resolve(found[2]()).catch(function (e) {
      view.innerHTML = '<p class="pill bad">Gagal: ' + esc(e.message) + "</p>";
    });
  }

  // ── Ringkasan ─────────────────────────────────────────────
  function renderRingkasan() {
    return api("/api/admin/report").then(function (b) {
      var r = b.report, l = r.ledger;
      var stockRows = Object.keys(r.stock || {}).map(function (v) {
        return "<tr><td>" + esc(v) + "</td><td class='num'>" + r.stock[v] + "</td></tr>";
      }).join("") || "<tr><td colspan='2' class='muted'>stok kosong</td></tr>";
      var orders = b.recentOrders.map(function (o) {
        return "<tr><td>" + esc(o.orderCode) + "</td><td>" + pill(o.status) + "</td><td>" + esc(o.buyerName) +
          "</td><td class='num'>" + esc(o.subtotalText) + "</td><td>" + time(o.createdAt) + "</td></tr>";
      }).join("") || "<tr><td colspan='5' class='muted'>belum ada pesanan</td></tr>";
      view.innerHTML =
        '<div class="cards">' +
        card("Omzet", rp(l.revenue)) + card("Biaya gateway", rp(l.fee)) +
        card("Modal barang", rp(l.cogs)) + card("Laba", rp(l.profit)) +
        card("Order lunas", String(l.orders)) + card("Menunggu bayar", String(r.pendingOrders)) +
        card("Gagal kirim", String(r.failedOrders)) +
        "</div>" +
        '<p class="muted">Penyimpanan: ' + esc(r.storage.backend) + " (durable=" + r.storage.durable + ") · " +
        '<button class="btn sm" id="sweep">Jalankan sweep</button></p>' +
        "<h2>Stok tersedia</h2><table><tr><th>Varian</th><th>Jumlah</th></tr>" + stockRows + "</table>" +
        "<h2>Order terakhir</h2><table><tr><th>Kode</th><th>Status</th><th>Pembeli</th><th>Nilai</th><th>Waktu</th></tr>" + orders + "</table>";
      document.getElementById("sweep").onclick = function () {
        post("/api/admin/sweep", {}).then(function (s) {
          toast("sweep: " + s.expired.length + " expired, " + s.redelivered.length + " terkirim ulang");
          run();
        }).catch(function (e) { toast(e.message, true); });
      };
    });
  }
  function card(label, value) { return '<div class="card"><span>' + esc(label) + "</span><b>" + esc(value) + "</b></div>"; }

  // ── Katalog ───────────────────────────────────────────────
  var variantRows = [];
  function productForm(p) {
    p = p || { name: "", slug: "", description: "", sort: 0, active: true, variants: [] };
    variantRows = (p.variants || []).map(function (v) { return Object.assign({}, v); });
    var form = document.createElement("form");
    form.className = "panel";
    form.innerHTML =
      "<h2 style='margin-top:0'>" + (p.slug ? "Edit produk: " + esc(p.name) : "Produk baru") + "</h2>" +
      '<div class="row"><div><label>Nama</label><input name="name" required value="' + esc(p.name) + '"></div>' +
      '<div><label>Slug</label><input name="slug" value="' + esc(p.slug) + '" placeholder="auto dari nama"></div></div>' +
      '<div><label>Deskripsi</label><textarea name="description">' + esc(p.description) + "</textarea></div>" +
      '<div class="row"><div><label>Urutan</label><input name="sort" type="number" value="' + esc(p.sort || 0) + '"></div>' +
      '<div><label>Status</label><select name="active"><option value="true"' + (p.active !== false ? " selected" : "") +
      ">Dijual</option><option value=\"false\"" + (p.active === false ? " selected" : "") + ">Disembunyikan</option></select></div></div>" +
      '<div id="variants"></div>' +
      '<div><button type="button" class="btn sm" id="addv">+ Varian</button></div>' +
      '<div class="row"><button class="btn p" type="submit">Simpan</button>' +
      '<button class="btn" type="button" id="cancel">Batal</button></div>';
    view.innerHTML = "";
    view.appendChild(form);
    function drawVariants() {
      var box = form.querySelector("#variants");
      box.innerHTML = "";
      variantRows.forEach(function (v, i) {
        var div = document.createElement("div");
        div.className = "variant";
        div.innerHTML =
          '<div class="row"><div><label>ID varian</label><input data-k="id" value="' + esc(v.id) + '" placeholder="v_nama" required></div>' +
          '<div><label>Nama</label><input data-k="name" value="' + esc(v.name) + '" placeholder="1 Bulan" required></div></div>' +
          '<div class="row"><div><label>Harga jual (Rp)</label><input data-k="price" value="' + esc(v.price) + '" inputmode="numeric" required></div>' +
          '<div><label>Modal (Rp)</label><input data-k="cost" value="' + esc(v.cost) + '" inputmode="numeric" required></div></div>' +
          '<div class="row"><div><label>Garansi</label><input data-k="warranty" value="' + esc(v.warranty || "") + '"></div>' +
          '<div><label>Tier qty (opsional)</label><input data-k="tiers" value="' + esc((v.tiers || []).map(function (t) { return t.minQty + ":" + t.unitPrice; }).join(",")) + '" placeholder="3:60000,5:55000"></div></div>' +
          '<div><label>S&K</label><input data-k="terms" value="' + esc(v.terms || "") + '"></div>' +
          '<div><button type="button" class="btn d sm" data-rm="' + i + '">Hapus varian</button></div>';
        box.appendChild(div);
      });
    }
    drawVariants();
    form.querySelector("#addv").onclick = function () {
      collectVariants(form);
      variantRows.push({ id: "", name: "", price: "", cost: "", warranty: "", terms: "", tiers: [] });
      drawVariants();
    };
    form.querySelector("#cancel").onclick = function () { current === "katalog" && renderKatalogList(); };
    box_rm(form);
    function box_rm(f) {
      f.addEventListener("click", function (e) {
        var rm = e.target.getAttribute && e.target.getAttribute("data-rm");
        if (rm !== null && rm !== undefined) { collectVariants(f); variantRows.splice(Number(rm), 1); drawVariants(); }
      });
    }
    function collectVariants(f) {
      Array.prototype.forEach.call(f.querySelectorAll(".variant"), function (div, i) {
        var row = variantRows[i];
        ["id", "name", "price", "cost", "warranty", "terms", "tiers"].forEach(function (k) {
          var el = div.querySelector('[data-k="' + k + '"]');
          if (el) row[k] = el.value.trim();
        });
      });
    }
    form.onsubmit = function (e) {
      e.preventDefault();
      collectVariants(form);
      var variants = variantRows.filter(function (v) { return v.id && v.name; }).map(function (v) {
        var tiers = String(v.tiers || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
          var parts = s.split(":");
          return { minQty: Number(parts[0]), unitPrice: Number(String(parts[1]).replace(/[.]/g, "")) };
        });
        return {
          id: v.id, name: v.name, price: v.price, cost: v.cost,
          warranty: v.warranty, terms: v.terms, tiers: tiers
        };
      });
      post("/api/admin/products", { product: {
        slug: form.slug.value.trim() || undefined,
        name: form.name.value.trim(),
        description: form.description.value.trim(),
        sort: Number(form.sort.value) || 0,
        active: form.active.value === "true",
        variants: variants
      } }).then(function (res) {
        toast("produk tersimpan: " + res.product.slug);
        renderKatalogList();
      }).catch(function (err) { toast(err.message, true); });
    };
  }
  function renderKatalog() { return renderKatalogList(); }
  function renderKatalogList() {
    return api("/api/admin/catalog").then(function (b) {
      var rows = b.products.map(function (p) {
        var variants = p.variants.map(function (v) {
          return "<tr><td>" + esc(v.id) + "</td><td>" + esc(v.name) + "</td><td class='num'>" + rp(v.price) +
            "</td><td class='num muted'>" + rp(v.cost) + "</td><td class='num'>" + (b.stock[v.id] || 0) + "</td></tr>";
        }).join("");
        return '<tr><td><b>' + esc(p.name) + "</b><br><span class='muted'>" + esc(p.slug) + "</span></td>" +
          "<td>" + pill(p.active ? "OK" : "OFF") + "</td>" +
          "<td style='white-space:nowrap'><button class='btn sm' data-edit='" + esc(p.slug) + "'>Edit</button> " +
          '<button class="btn sm" data-toggle="' + esc(p.slug) + '" data-on="' + (p.active ? "0" : "1") + '">' + (p.active ? "Sembunyikan" : "Tampilkan") + "</button> " +
          '<button class="btn d sm" data-del="' + esc(p.slug) + '">Hapus</button></td>' +
          "<td><table>" + variants + "</table></td></tr>";
      }).join("") || "<tr><td class='muted'>belum ada produk</td></tr>";
      view.innerHTML =
        '<p><button class="btn p" id="new">+ Produk baru</button></p>' +
        "<table><tr><th>Produk</th><th>Status</th><th>Aksi</th><th>Varian · harga · modal · stok</th></tr>" + rows + "</table>";
      document.getElementById("new").onclick = function () { productForm(null); };
      view.querySelectorAll("[data-edit]").forEach(function (btn) {
        btn.onclick = function () {
          var slug = btn.getAttribute("data-edit");
          api("/api/admin/catalog").then(function (b2) {
            productForm(b2.products.filter(function (p) { return p.slug === slug; })[0]);
          });
        };
      });
      view.querySelectorAll("[data-toggle]").forEach(function (btn) {
        btn.onclick = function () {
          post("/api/admin/products/" + encodeURIComponent(btn.getAttribute("data-toggle")) + "/active",
            { active: btn.getAttribute("data-on") === "1" }).then(renderKatalogList).catch(function (e) { toast(e.message, true); });
        };
      });
      view.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.onclick = function () {
          var slug = btn.getAttribute("data-del");
          if (!window.confirm("Hapus produk " + slug + "?")) return;
          del("/api/admin/products/" + encodeURIComponent(slug)).then(renderKatalogList).catch(function (e) { toast(e.message, true); });
        };
      });
    });
  }

  // ── Stok ──────────────────────────────────────────────────
  function renderStok() {
    return Promise.all([api("/api/admin/catalog"), api("/api/admin/stock?limit=100")]).then(function (bs) {
      var catalog = bs[0], stock = bs[1].items;
      var opts = [];
      catalog.products.forEach(function (p) {
        p.variants.forEach(function (v) { opts.push('<option value="' + esc(v.id) + '">' + esc(p.name + " — " + v.name) + "</option>"); });
      });
      var rows = stock.map(function (s) {
        return "<tr><td>" + esc(s.variantId) + "</td><td>" + pill(s.status) + "</td><td>" + esc(s.payload) +
          "</td><td class='num'>" + rp(s.cost) + "</td><td>" + time(s.createdAt) + "</td></tr>";
      }).join("") || "<tr><td colspan='5' class='muted'>kosong</td></tr>";
      view.innerHTML =
        '<form class="panel" id="addform"><h2 style="margin-top:0">Isi stok (satu payload per baris)</h2>' +
        '<label>Varian</label><select name="variantId" required>' + opts.join("") + "</select>" +
        '<label>Modal per item (Rp, kosong = pakai modal varian)</label><input name="cost" inputmode="numeric">' +
        '<label>Payload — kode voucher / akun, satu per baris</label><textarea name="payloads" placeholder="KODE1&#10;KODE2" required></textarea>' +
        '<button class="btn p" type="submit">Simpan stok</button></form>' +
        "<h2>Isi stok terakhir</h2><table><tr><th>Varian</th><th>Status</th><th>Payload</th><th>Modal</th><th>Waktu</th></tr>" + rows + "</table>";
      document.getElementById("addform").onsubmit = function (e) {
        e.preventDefault();
        var f = e.target;
        var payloads = f.payloads.value.split("\\n").map(function (s) { return s.trim(); }).filter(Boolean);
        var cost = f.cost.value ? Number(f.cost.value.replace(/[.\\s]/g, "")) : 0;
        var items = payloads.map(function (p) { return { variantId: f.variantId.value, payload: p, cost: cost }; });
        if (!items.length) { toast("payload kosong", true); return; }
        post("/api/admin/stock", { items: items }).then(function (res) {
          toast("masuk " + res.added + " item");
          renderStok();
        }).catch(function (err) { toast(err.message, true); });
      };
    });
  }

  // ── Pesanan ───────────────────────────────────────────────
  function renderPesanan() {
    return api("/api/admin/report").then(function (b) {
      var rows = b.recentOrders.map(function (o) {
        var cancel = o.status === "PENDING_PAYMENT"
          ? '<button class="btn d sm" data-cancel="' + esc(o.orderCode) + '">Batalkan</button>' : "";
        var detail = (o.lines || []).map(function (l) { return esc(l.variantName) + " x" + l.qty; }).join(", ");
        return "<tr><td>" + esc(o.orderCode) + "</td><td>" + pill(o.status) + "</td><td>" + esc(o.buyerName) +
          "<br><span class='muted'>" + esc(o.buyerContact) + "</span></td><td>" + detail +
          "</td><td class='num'>" + esc(o.subtotalText) + "</td><td>" + time(o.createdAt) + "</td><td>" + cancel + "</td></tr>";
      }).join("") || "<tr><td colspan='7' class='muted'>belum ada pesanan</td></tr>";
      view.innerHTML = "<table><tr><th>Kode</th><th>Status</th><th>Pembeli</th><th>Isi</th><th>Nilai</th><th>Waktu</th><th></th></tr>" + rows + "</table>";
      view.querySelectorAll("[data-cancel]").forEach(function (btn) {
        btn.onclick = function () {
          post("/api/admin/orders/" + encodeURIComponent(btn.getAttribute("data-cancel")) + "/cancel", {})
            .then(function () { toast("dibatalkan, stok kembali"); renderPesanan(); })
            .catch(function (e) { toast(e.message, true); });
        };
      });
    });
  }

  // ── Pembayaran ────────────────────────────────────────────
  function renderPembayaran() {
    return api("/api/admin/payments?limit=100").then(function (b) {
      var rows = b.payments.map(function (p) {
        return "<tr><td>" + esc(p.orderCode) + "</td><td>" + esc(p.invoiceId) + "</td><td class='num'>" + rp(p.amount) +
          "</td><td>" + esc(p.senderName || "-") + "</td><td>" + time(p.paidAt) + "</td></tr>";
      }).join("") || "<tr><td colspan='5' class='muted'>belum ada pembayaran</td></tr>";
      view.innerHTML = "<table><tr><th>Order</th><th>Invoice</th><th>Nominal</th><th>Pengirim</th><th>Waktu</th></tr>" + rows + "</table>";
    });
  }

  document.getElementById("btn-savekey").onclick = function () { askKey(true) && run(); };
  drawTabs();
  run();
})();
</script>
</body>
</html>`;
}
