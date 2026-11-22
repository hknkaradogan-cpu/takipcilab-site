import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function callProvider(params: Record<string, string>) {
  const { data: cfg } = await admin.from("provider_config").select("*").eq("id", 1).single();
  if (!cfg?.api_url || !cfg?.api_key) throw new Error("Sağlayıcı API adresi ve anahtarı girilmemiş");
  const body = new URLSearchParams({ key: cfg.api_key, ...params });
  const r = await fetch(cfg.api_url, { method: "POST", body, signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error("Sağlayıcıdan geçersiz yanıt: " + text.slice(0, 120)); }
  if (data && !Array.isArray(data) && data.error) throw new Error("Sağlayıcı: " + data.error);
  return data;
}

const STATUS_MAP: Record<string, number> = { completed: 3, partial: 3, canceled: 4, cancelled: 4, refunded: 4 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    const email = u?.user?.email?.toLowerCase();
    if (!email) return json({ error: "Giriş gerekli" }, 401);
    const { data: isAdm } = await admin.from("admins").select("email").ilike("email", email).maybeSingle();
    if (!isAdm) return json({ error: "Yetki yok" }, 403);

    const p = await req.json().catch(() => ({}));
    switch (p.action) {
      case "config_get": {
        const { data } = await admin.from("provider_config").select("api_url,api_key").eq("id", 1).single();
        return json({ api_url: data?.api_url || "", has_key: !!data?.api_key });
      }
      case "config_set": {
        const upd: Record<string, string> = { api_url: String(p.api_url || "").trim() };
        if (p.api_key) upd.api_key = String(p.api_key).trim();
        if (upd.api_url && !/^https:\/\//i.test(upd.api_url)) return json({ error: "API adresi https:// ile başlamalı" }, 400);
        await admin.from("provider_config").update(upd).eq("id", 1);
        return json({ ok: true });
      }
      case "balance":
        return json(await callProvider({ action: "balance" }));
      case "services": {
        const list = await callProvider({ action: "services" });
        return json((Array.isArray(list) ? list : []).map((s: any) => ({
          id: s.service, name: s.name, cat: s.category, rate: s.rate, min: s.min, max: s.max,
        })));
      }
      case "send": {
        const { data: o } = await admin.from("orders").select("*, services(provider_service_id)").eq("id", p.order_id).single();
        if (!o) return json({ error: "Sipariş bulunamadı" }, 404);
        if (o.provider_order_id) return json({ error: "Bu sipariş zaten gönderilmiş" }, 400);
        if (o.status !== 1) return json({ error: "Önce ödemeyi onayla" }, 400);
        const sid = o.services?.provider_service_id;
        if (!sid) return json({ error: "Bu hizmet için sağlayıcı servis ID'si girilmemiş (Sağlayıcı sekmesi)" }, 400);
        const r = await callProvider({ action: "add", service: String(sid), link: o.link, quantity: String(o.qty + (o.bonus || 0)) });
        if (!r.order) return json({ error: "Sağlayıcı sipariş numarası dönmedi" }, 502);
        await admin.from("orders").update({ provider_order_id: String(r.order), status: 2, provider_status: "Pending", updated_at: new Date().toISOString() }).eq("id", o.id);
        return json({ ok: true, provider_order_id: r.order });
      }
      case "manual": {
        const qty = Number(p.quantity);
        const { data: s } = await admin.from("services").select("*").eq("id", p.service_id).single();
        if (!s?.provider_service_id) return json({ error: "Bu hizmet için sağlayıcı servis ID'si girilmemiş" }, 400);
        const link = String(p.link || "").trim();
        if (link.length < 5 || !Number.isInteger(qty) || qty < 1) return json({ error: "Bağlantı ve miktar gerekli" }, 400);
        const r = await callProvider({ action: "add", service: String(s.provider_service_id), link, quantity: String(qty) });
        if (!r.order) return json({ error: "Sağlayıcı sipariş numarası dönmedi" }, 502);
        let id = "";
        for (let i = 0; i < 5; i++) {
          id = "TL" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
          const { error } = await admin.from("orders").insert({
            id, service_id: s.id, qty, bonus: 0, price: 0, link, name: "Yönetici gönderimi", email: email, phone: "-",
            is_manual: true, status: 2, provider_order_id: String(r.order), provider_status: "Pending",
          });
          if (!error) break;
        }
        return json({ ok: true, id, provider_order_id: r.order });
      }
      case "sync": {
        const { data: list } = await admin.from("orders").select("id,provider_order_id").eq("status", 2).not("provider_order_id", "is", null).limit(100);
        if (!list?.length) return json({ updated: 0 });
        const r = await callProvider({ action: "status", orders: list.map((o) => o.provider_order_id).join(",") });
        let updated = 0;
        for (const o of list) {
          const st = r?.[o.provider_order_id!];
          if (!st || st.error) continue;
          const name = String(st.status || "");
          const upd: Record<string, unknown> = { provider_status: name, provider_remains: st.remains != null ? Number(st.remains) : null, updated_at: new Date().toISOString() };
          const mapped = STATUS_MAP[name.toLowerCase()];
          if (mapped) upd.status = mapped;
          await admin.from("orders").update(upd).eq("id", o.id);
          updated++;
        }
        return json({ updated });
      }
      default:
        return json({ error: "Bilinmeyen işlem" }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "Hata" }, 500);
  }
});
