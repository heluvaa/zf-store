/**
 * Gerai toko satu halaman di / — HTML + JS inline, tanpa framework dan tanpa
 * asset eksternal (halaman admin memakai pola yang sama). Semuanya bicara ke
 * API yang sudah ada: /api/catalog, /api/orders, /api/orders/:code?t=token.
 * Token pembeli disimpan di localStorage supaya status pesanan bisa dibuka
 * lagi setelah tutup browser.
 */
export function storefrontHtml(brand: string): string {
  const brandSafe = brand
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brandSafe}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 system-ui, sans-serif; background: #f5f6f8; color: #16181d; }
  header { background: #16181d; color: #fff; padding: 14px 18px; display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 3; }
  header h1 { font-size: 17px; margin: 0; flex: 1; }
  header a { color: #9ecbff; font-size: 13px; text-decoration: none; }
  main { max-width: 860px; margin: 0 auto; padding: 16px 14px 90px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; }
  .card h3 { margin: 0 0 4px; font-size: 16px; }
  .desc { color: #555b66; font-size: 13.5px; margin: 0 0 10px; }
  .variant { display: flex; gap: 8px; align-items: center; border-top: 1px dashed #e3e6ea; padding: 10px 0; flex-wrap: wrap; }
  .variant .vn { flex: 1; min-width: 140px; }
  .variant .vn b { display: block; }
  .variant .vn small { color: #6b7280; }
  .price { font-weight: 700; white-space: nowrap; }
  .oos { color: #b00020; font-size: 12px; }
  input, select, textarea { border: 1px solid #cfd4da; border-radius: 8px; padding: 8px 10px; font: inherit; width: 100%; background: #fff; }
  .qty { width: 64px; text-align: center; }
  button { border: 0; border-radius: 8px; padding: 9px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  .cta { background: #16181d; color: #fff; } .cta:disabled { opacity: .4; cursor: default; }
  .cta.g { background: #0a7d3c; }
  .ghost { background: #eef0f3; }
  #cart { position: fixed; bottom: 0; left: 0; right: 0; background: #16181d; color: #fff; padding: 10px 14px; display: flex; gap: 10px; align-items: center; z-index: 3; }
  #cart .cc { flex: 1; font-size: 14px; }
  /* modal */
  .overlay { position: fixed; inset: 0; background: rgba(10,12,16,.55); display: none; align-items: flex-start; justify-content: center; padding: 4vh 12px; overflow: auto; z-index: 5; }
  .overlay.on { display: flex; }
  .sheet { background: #fff; border-radius: 14px; max-width: 460px; width: 100%; padding: 16px; }
  .sheet h2 { margin: 0 0 10px; font-size: 17px; }
  .row { display: flex; gap: 8px; margin-bottom: 8px; }
  .row > div { flex: 1; }
  label { font-size: 12px; color: #555b66; }
  .li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px dashed #e3e6ea; font-size: 14px; }
  .total { display: flex; justify-content: space-between; font-weight: 700; padding: 10px 0; }
  .code { font-family: ui-monospace, monospace; background: #f2f4f7; border-radius: 8px; padding: 8px 10px; word-break: break-all; }
  .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12.5px; font-weight: 700; background: #eef0f3; }
  .p-warn { background: #fff3cd; color: #7a5b00; } .p-ok { background: #d6f5e0; color: #0a7d3c; } .p-bad { background: #fde2e2; color: #b00020; }
  .muted { color: #6b7280; font-size: 13px; }
  .timer { font-variant-numeric: tabular-nums; }
  .reveal { background: #f2f4f7; border-radius: 10px; padding: 10px 12px; margin-top: 8px; font-family: ui-monospace, monospace; word-break: break-all; }
  .errbox { background: #fde2e2; color: #b00020; border-radius: 8px; padding: 8px 12px; font-size: 14px; margin-top: 8px; display: none; }
</style>
</head>
<body>
<header>
  <h1>${brandSafe}</h1>
  <a id="lnk-cart" href="#">Keranjang <span id="cartn">0</span></a>
</header>
<main>
  <div id="goods"><p class="muted">Memuat katalog…</p></div>
  <noscript><p>Halaman ini butuh JavaScript untuk checkout.</p></noscript>
  <p class="muted" style="margin-top:20px">Pembayaran QRIS (semua bank/e-wallet). Kode pesanan dikirim otomatis setelah lunas.</p>
</main>
<div id="cart" hidden>
  <div class="cc"><span id="cartc">0</span> item · <span id="cartt">Rp 0</span></div>
  <button class="cta g" id="btn-cart">Checkout</button>
</div>

<div class="overlay" id="ov-form"><div class="sheet">
  <h2>Data pembeli</h2>
  <div class="li"><span>Nama / nama WA</span><b id="f-sum">Rp 0</b></div>
  <div class="li"><span>Kontak (nomor WA / ID tujuan)</span></div>
  <div class="row"><div><label>Nama <span class="muted">(min 2)</span></label><input id="f-name" maxlength="60"></div></div>
  <div class="row"><div><label>Kontak <span class="muted">(dipakai mengirim barang + menghubungi kamu)</span></label><input id="f-contact" maxlength="80"></div></div>
  <div id="cart-lines"></div>
  <div class="errbox" id="form-err"></div>
  <div class="row" style="margin-top:10px">
    <button class="ghost" data-close="ov-form">Batal</button>
    <button class="cta g" id="btn-buy">Bayar QRIS</button>
  </div>
</div></div>

<div class="overlay" id="ov-pay"><div class="sheet">
  <h2>Pembayaran</h2>
  <p class="muted">Pesanan <b id="pay-code" class="code" style="display:inline-block;padding:2px 8px"></b>
  <span class="pill p-warn" id="pay-status">MENUNGGU</span></p>
  <div class="total"><span>Total bayar</span><span id="pay-amt"></span></div>
  <p class="muted">Nominal <b>harus pas termasuk kode unik</b> di akhir. Sisa <span class="timer" id="pay-timer">–</span></p>
  <div class="row">
    <a class="cta" id="pay-qr" href="#" target="_blank" style="text-align:center;text-decoration:none;display:block;flex:1">Buka QRIS</a>
  </div>
  <p class="muted">QR terbuka di tab baru — simpan / scan dari situ. Status di halaman ini berubah otomatis begitu lunas.</p>
  <details style="margin-top:8px"><summary class="muted">Tersimpan? simpan tautan pesanan ini</summary>
    <div class="code" id="pay-link" style="font-size:12px;margin-top:6px"></div></details>
  <div class="errbox" id="pay-err"></div>
  <div class="row" style="margin-top:12px"><button class="ghost" data-close="ov-pay">Tutup</button></div>
</div></div>

<div class="overlay" id="ov-done"><div class="sheet">
  <h2>Pesanan <span id="done-code"></span> <span class="pill" id="done-status"></span></h2>
  <div id="done-body"></div>
  <div class="row" style="margin-top:12px"><button class="ghost" data-close="ov-done">Tutup</button></div>
</div></div>

<script>
(function () {
  "use strict";
  var LS_CART = "zf_cart", LS_TOKENS = "zf_my_orders";
  var catalog = { products: [] };
  var cart = {}; try { cart = JSON.parse(localStorage.getItem(LS_CART)) || {}; } catch (e) {}
  var myOrders = {}; try { myOrders = JSON.parse(localStorage.getItem(LS_TOKENS)) || {}; } catch (e) {}
  function saveCart() { localStorage.setItem(LS_CART, JSON.stringify(cart)); }
  function rp(n) { return "Rp " + String(Math.trunc(Math.abs(n))).replace(/\\B(?=(\\d{3})+(?!\\d))/g, "."); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function tierFor(v, qty) {
    var best = v.price;
    (v.tiers || []).forEach(function (t) { if (qty >= t.minQty && t.unitPrice < best) best = t.unitPrice; });
    return best;
  }
  function cartLines() {
    return Object.keys(cart).map(function (id) {
      var got = findVariant(id); if (!got) return null;
      var qty = cart[id];
      return { id: id, name: got.p.name + " — " + got.v.name, unit: tierFor(got.v, qty), qty: qty, total: tierFor(got.v, qty) * qty, max: got.v.stock };
    }).filter(Boolean);
  }
  function findVariant(id) {
    for (var i = 0; i < catalog.products.length; i++) {
      var p = catalog.products[i];
      for (var j = 0; j < p.variants.length; j++) if (p.variants[j].id === id) return { p: p, v: p.variants[j] };
    }
    return null;
  }
  function cartCount() { return cartLines().reduce(function (s, l) { return s + l.qty; }, 0); }
  function cartTotal() { return cartLines().reduce(function (s, l) { return s + l.total; }, 0); }

  function drawCartBar() {
    var n = cartCount(), lines = cartLines();
    document.getElementById("cartn").textContent = n;
    document.getElementById("cartc").textContent = n;
    document.getElementById("cartt").textContent = rp(cartTotal());
    document.getElementById("cart").hidden = n === 0;
    document.getElementById("cart-lines").innerHTML = lines.map(function (l) {
      return "<div class='li'><span>" + esc(l.name) + " x" + l.qty + "</span><span>" + rp(l.total) + "</span></div>";
    }).join("");
    document.getElementById("f-sum").textContent = rp(cartTotal());
  }

  function drawCatalog() {
    var box = document.getElementById("goods");
    if (!catalog.products.length) { box.innerHTML = "<div class='card'>Belum ada produk.</div>"; return; }
    box.innerHTML = catalog.products.map(function (p) {
      return "<div class='card'><h3>" + esc(p.name) + "</h3><p class='desc'>" + esc(p.description) + "</p>" +
        p.variants.map(function (v) {
          var tierTxt = (v.tiers || []).map(function (t) { return "<small>jual " + t.minQty + "+: " + rp(t.unitPrice) + "/pcs</small>"; }).join(" ");
          var oos = v.stock <= 0 ? "<span class='oos'>stok habis</span>" : "";
          return "<div class='variant'><div class='vn'><b>" + esc(v.name) + "</b><small>" + esc(v.warranty) + "</small>" + (tierTxt ? "<br>" + tierTxt : "") + "</div>" +
            "<span class='price'>" + rp(v.price) + " " + oos + "</span>" +
            "<input class='qty' type='number' min='1' max='" + Math.max(v.stock, 1) + "' value='1' data-v='" + esc(v.id) + "'" + (v.stock <= 0 ? " disabled" : "") + ">" +
            "<button class='cta' data-add='" + esc(v.id) + "'" + (v.stock <= 0 ? " disabled" : "") + "+</button></div>";
        }).join("") + "</div>";
    }).join("");
  }

  document.getElementById("goods").addEventListener("click", function (e) {
    var id = e.target.getAttribute && e.target.getAttribute("data-add");
    if (!id) return;
    var qtyEl = document.querySelector("[data-v='" + id + "']");
    var qty = Math.max(1, Number(qtyEl && qtyEl.value) || 1);
    var got = findVariant(id); if (!got) return;
    if (qty > got.v.stock) { qty = got.v.stock; qtyEl.value = qty; }
    if (qty <= 0) return;
    cart[id] = (cart[id] || 0) + qty;
    saveCart(); drawCartBar();
  });

  // overlay helpers
  function openOv(id) { document.getElementById(id).classList.add("on"); }
  function closeOv(id) { document.getElementById(id).classList.remove("on"); }
  document.addEventListener("click", function (e) {
    var c = e.target.getAttribute && e.target.getAttribute("data-close");
    if (c) closeOv(c);
    if (e.target.classList && e.target.classList.contains("overlay")) closeOv(e.target.id);
  });

  document.getElementById("btn-cart").onclick = function () {
    if (!cartCount()) return;
    document.getElementById("form-err").style.display = "none";
    drawCartBar(); openOv("ov-form");
  };

  var polling = null;
  document.getElementById("btn-buy").onclick = function () {
    var name = document.getElementById("f-name").value.trim();
    var contact = document.getElementById("f-contact").value.trim();
    var err = document.getElementById("form-err");
    function showErr(m) { err.textContent = m; err.style.display = "block"; }
    if (name.length < 2) return showErr("Nama minimal 2 karakter.");
    if (contact.length < 5) return showErr("Isi kontak (nomor WA / ID tujuan) dengan benar.");
    err.style.display = "none";
    document.getElementById("btn-buy").disabled = true;
    fetch("/api/orders", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: cartLines().map(function (l) { return { variantId: l.id, qty: l.qty }; }),
        buyer: { name: name, contact: contact }
      })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      document.getElementById("btn-buy").disabled = false;
      if (res.status !== 201) return showErr(res.j.message || res.j.error || "Pesanan gagal dibuat.");
      var j = res.j;
      myOrders[j.orderCode] = j.accessToken;
      localStorage.setItem(LS_TOKENS, JSON.stringify(myOrders));
      cart = {}; saveCart(); drawCartBar();
      closeOv("ov-form");
      startPay(j);
    }).catch(function (e) {
      document.getElementById("btn-buy").disabled = false;
      showErr("Jaringan bermasalah: " + e.message);
    });
  };

  function startPay(j) {
    // Menerima dua bentuk: hasil POST /api/orders ({pay:{...}}) dan view GET order
    // (bidang datar: chargedAmount/qrisUrl/expiresAt).
    var pay = j.pay || j;
    document.getElementById("pay-code").textContent = j.orderCode;
    document.getElementById("pay-amt").textContent = (pay.chargedAmountText || rp(pay.chargedAmount)) + " (pas, termasuk kode unik)";
    var qr = document.getElementById("pay-qr");
    qr.href = pay.qrisUrl + "&view=1";
    document.getElementById("pay-link").textContent =
      location.origin + "/?order=" + j.orderCode + "#t=" + j.accessToken;
    document.getElementById("pay-err").style.display = "none";
    openOv("ov-pay");
    poll(j.orderCode, j.accessToken, "ov-pay");
  }

  function setStatusPill(el, status) {
    var map = { PENDING_PAYMENT: ["p-warn", "MENUNGGU BAYAR"], PAID: ["p-ok", "LUNAS — MEMPROSES"],
      DELIVERING: ["p-ok", "SEDANG DIKIRIM"], DELIVERED: ["p-ok", "SELESAI"],
      EXPIRED: ["p-bad", "KEDALUWARSA"], CANCELLED: ["p-bad", "DIBATALKAN"], FAILED: ["p-bad", "GAGAL — HUBUNGI PENJUAL"] };
    var s = map[status] || ["", status];
    el.className = "pill " + s[0]; el.textContent = s[1];
  }

  function poll(code, token, overlayId) {
    stopPoll();
    var pill = document.getElementById(overlayId === "ov-pay" ? "pay-status" : "done-status");
    var timerEl = document.getElementById("pay-timer");
    var deadline = null;
    function tick() {
      fetch("/api/orders/" + encodeURIComponent(code) + "?t=" + encodeURIComponent(token))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) {
          if (!v) return;
          setStatusPill(pill, v.status);
          if (v.expiresAt) {
            deadline = new Date(v.expiresAt).getTime();
            if (timerEl && deadline) {
              var left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
              timerEl.textContent = Math.floor(left / 60) + "m " + (left % 60) + "s";
            }
          }
          if (v.status === "DELIVERED") {
            stopPoll();
            if (overlayId === "ov-pay") closeOv("ov-pay");
            showDelivered(v);
          } else if (v.status === "EXPIRED" || v.status === "CANCELLED" || v.status === "FAILED") {
            stopPoll();
            var eb = document.getElementById(overlayId === "ov-pay" ? "pay-err" : "done-body");
            if (eb) { eb.textContent = v.note; eb.style.display = "block"; }
          }
        }).catch(function () {});
    }
    tick();
    polling = setInterval(tick, 5000);
  }
  function stopPoll() { if (polling) { clearInterval(polling); polling = null; } }

  function showDelivered(v) {
    document.getElementById("done-code").textContent = v.orderCode;
    setStatusPill(document.getElementById("done-status"), "DELIVERED");
    var items = (v.delivered || []).map(function (d) { return "<div class='reveal'>" + esc(d.payload) + "</div>"; }).join("");
    document.getElementById("done-body").innerHTML =
      "<p class='muted'>" + esc(v.note) + "</p>" + items +
      "<button class='cta g' style='margin-top:10px' id='copy-all'>Salin semua</button>";
    var ca = document.getElementById("copy-all");
    if (ca) ca.onclick = function () {
      var txt = (v.delivered || []).map(function (d) { return d.payload; }).join("\\n");
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
        .then(function () { ca.textContent = "Tersalin ✓"; })
        .catch(function () { ca.textContent = txt; });
    };
    openOv("ov-done");
  }

  document.getElementById("lnk-cart").onclick = function (e) { e.preventDefault(); drawCartBar(); if (!cartCount()) return; document.getElementById("btn-cart").click(); };

  function loadCatalog() {
    return fetch("/api/catalog").then(function (r) { return r.json(); }).then(function (j) {
      catalog = j; drawCatalog(); drawCartBar();
    });
  }

  // buka status dari tautan /?order=CODE#t=TOKEN
  (function () {
    var m = location.search.match(/[?&]order=([A-Z0-9-]+)/);
    var tok = (location.hash.match(/#t=([a-z0-9]+)/) || [])[1] || (myOrders[m && m[1]] || null);
    if (m && tok) {
      var code = m[1];
      fetch("/api/orders/" + code + "?t=" + tok).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
        if (!v) return;
        if (v.status === "DELIVERED") { showDelivered(v); return; }
        if (v.qrisUrl) { startPay({ orderCode: code, accessToken: tok, pay: v }); poll(code, tok, "ov-pay"); }
        else { document.getElementById("done-code").textContent = code; setStatusPill(document.getElementById("done-status"), v.status); document.getElementById("done-body").innerHTML = "<p class='muted'>" + esc(v.note) + "</p>"; openOv("ov-done"); }
      });
    }
  })();

  loadCatalog().catch(function () { document.getElementById("goods").innerHTML = "<div class='card'>Gagal memuat katalog — muat ulang.</div>"; });
})();
</script>
</body>
</html>`;
}
