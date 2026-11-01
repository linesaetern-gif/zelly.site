'use strict';
/* Email notifications (lo / th / en, chosen by the recipient's saved language). Everything is fire-and-forget. */
const Mail = require('./mailer');
const LANGS = ['lo', 'th', 'en'];
const lg = u => (u && LANGS.includes(u.lang)) ? u.lang : 'lo';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-US') + ' ₭';
const base = () => (process.env.APP_URL || '').replace(/\/+$/, '');
const pick = (v, l) => (v && typeof v === 'object') ? (v[l] || v.en || v.th || v.lo || '') : String(v == null ? '' : v);

/* texts: [lo, th, en]; {x} placeholders */
const T = {
  welcome: { s: ['ຍິນດີຕ້ອນຮັບສູ່ Zelly', 'ยินดีต้อนรับสู่ Zelly', 'Welcome to Zelly'], h: ['ສະບາຍດີ {name}', 'สวัสดี {name}', 'Hello {name}'],
    b: ['ບັນຊີຂອງທ່ານຖືກສ້າງແລ້ວ. ເລີ່ມສ້າງຮ້ານ ເພີ່ມສິນຄ້າ ແລະ ແບ່ງປັນລິ້ງຮ້ານໄດ້ເລີຍ.', 'สร้างบัญชีของคุณเรียบร้อยแล้ว เริ่มสร้างร้าน เพิ่มสินค้า และแชร์ลิงก์ร้านได้เลย', 'Your account is ready. Create a shop, add products and share your store link.'],
    pend: ['ບັນຊີຂອງທ່ານກຳລັງລໍຖ້າການອະນຸມັດຈາກຜູ້ດູແລລະບົບ. ເມື່ອອະນຸມັດແລ້ວ ເຮົາຈະແຈ້ງໃຫ້ຮູ້.', 'บัญชีของคุณกำลังรอผู้ดูแลระบบอนุมัติ เมื่ออนุมัติแล้วเราจะแจ้งให้ทราบ', 'Your account is waiting for approval by the administrator. We will let you know once it is approved.'] },
  order: { s: ['ອໍເດີໃໝ່ {id} · {shop}', 'ออเดอร์ใหม่ {id} · {shop}', 'New order {id} · {shop}'], h: ['ມີອໍເດີໃໝ່ເຂົ້າມາ', 'มีออเดอร์ใหม่เข้ามา', 'You have a new order'],
    b: ['ຮ້ານ {shop} · ອໍເດີ {id} · ລູກຄ້າ {cust} · ຍອດລວມ {total}. ເຂົ້າລະບົບເພື່ອກວດສອບ ແລະ ຈັດສົ່ງ.', 'ร้าน {shop} · ออเดอร์ {id} · ลูกค้า {cust} · ยอดรวม {total} เข้าสู่ระบบเพื่อตรวจสอบและจัดส่ง', 'Shop {shop} · order {id} · customer {cust} · total {total}. Sign in to review and ship it.'] },
  paid: { s: ['ໃບຮັບເງິນ {pay} · ແພັກເກດ {plan}', 'ใบเสร็จ {pay} · แพ็กเกจ {plan}', 'Receipt {pay} · {plan} plan'], h: ['ຮັບຊຳລະແລ້ວ ຂອບໃຈ!', 'ได้รับชำระเงินแล้ว ขอบคุณ!', 'Payment received — thank you!'],
    b: ['ແພັກເກດ {plan} · {months} ເດືອນ · ຈຳນວນ {amount}. ໃຊ້ງານໄດ້ເຖິງ {exp}.', 'แพ็กเกจ {plan} · {months} เดือน · จำนวน {amount} ใช้งานได้ถึง {exp}', '{plan} plan · {months} month(s) · amount {amount}. Active until {exp}.'] },
  approved: { s: ['ອະນຸມັດການຊຳລະແລ້ວ · {plan}', 'อนุมัติการชำระเงินแล้ว · {plan}', 'Payment approved · {plan}'], h: ['ແພັກເກດຂອງທ່ານໃຊ້ງານໄດ້ແລ້ວ', 'แพ็กเกจของคุณเปิดใช้งานแล้ว', 'Your plan is now active'],
    b: ['ຄຳຂໍ {req} ຖືກອະນຸມັດ. ແພັກເກດ {plan} ໃຊ້ງານໄດ້ເຖິງ {exp}.', 'คำขอ {req} ได้รับการอนุมัติ แพ็กเกจ {plan} ใช้งานได้ถึง {exp}', 'Request {req} was approved. {plan} plan is active until {exp}.'] },
  rejected: { s: ['ສະລິບບໍ່ຖືກຕ້ອງ · {req}', 'สลิปไม่ถูกต้อง · {req}', 'Slip rejected · {req}'], h: ['ກະລຸນາສົ່ງສະລິບໃໝ່', 'กรุณาส่งสลิปใหม่', 'Please send a new slip'],
    b: ['ສະລິບຂອງຄຳຂໍ {req} ບໍ່ຜ່ານການກວດສອບ. ກະລຸນາອັບໂຫຼດສະລິບໃໝ່ ຫຼື ຊຳລະອອນໄລນ໌.', 'สลิปของคำขอ {req} ไม่ผ่านการตรวจสอบ กรุณาอัปโหลดสลิปใหม่ หรือชำระออนไลน์', 'The slip for request {req} did not pass review. Please upload a new slip or pay online.'] },
  slip: { s: ['ມີສະລິບລໍຖ້າກວດ · {req}', 'มีสลิปรอตรวจ · {req}', 'Slip waiting for review · {req}'], h: ['ມີການຊຳລະລໍຖ້າກວດສອບ', 'มีการชำระเงินรอตรวจสอบ', 'A payment is waiting for review'],
    b: ['{who} ສົ່ງສະລິບຄຳຂໍ {req} · ແພັກເກດ {plan} · {amount}.', '{who} ส่งสลิปคำขอ {req} · แพ็กเกจ {plan} · {amount}', '{who} sent a slip for {req} · {plan} plan · {amount}.'] },
  payreq: { s: ['ຂໍຖອນຄ່ານາຍໜ້າ {id} · {amount}', 'ขอถอนค่าแนะนำ {id} · {amount}', 'Affiliate payout request {id} · {amount}'], h: ['ມີຄຳຂໍຖອນຄ່ານາຍໜ້າ', 'มีคำขอถอนค่าแนะนำ', 'New affiliate payout request'],
    b: ['{who} ຂໍຖອນ {amount} · ບັນຊີ: {bank}', '{who} ขอถอน {amount} · บัญชี: {bank}', '{who} requested {amount} · account: {bank}'] },
  paypaid: { s: ['ໂອນຄ່ານາຍໜ້າແລ້ວ {id}', 'โอนค่าแนะนำแล้ว {id}', 'Affiliate payout sent {id}'], h: ['ໂອນເງິນແລ້ວ', 'โอนเงินเรียบร้อย', 'Your payout has been sent'],
    b: ['ຄຳຂໍ {id} ຈຳນວນ {amount} ຖືກໂອນແລ້ວ.', 'คำขอ {id} จำนวน {amount} โอนเรียบร้อยแล้ว', 'Payout {id} of {amount} has been sent.'] },
  payrej: { s: ['ຄຳຂໍຖອນຖືກປະຕິເສດ {id}', 'คำขอถอนถูกปฏิเสธ {id}', 'Payout rejected {id}'], h: ['ຄຳຂໍຖອນບໍ່ຜ່ານ', 'คำขอถอนไม่ผ่าน', 'Payout request rejected'],
    b: ['ຄຳຂໍ {id} ຈຳນວນ {amount} ຖືກປະຕິເສດ. ຍອດຍັງຢູ່ໃນບັນຊີຂອງທ່ານ.', 'คำขอ {id} จำนวน {amount} ถูกปฏิเสธ ยอดยังอยู่ในบัญชีของคุณ', 'Payout {id} of {amount} was rejected. The balance stays in your account.'] },
  comm: { s: ['ໄດ້ຮັບຄ່ານາຍໜ້າ {amount}', 'ได้รับค่าแนะนำ {amount}', 'You earned a commission {amount}'], h: ['ມີຄ່ານາຍໜ້າເຂົ້າ', 'มีค่าแนะนำเข้ามา', 'New referral commission'],
    b: ['{who} ຊຳລະແພັກເກດ ທ່ານໄດ້ຮັບ {amount}.', '{who} ชำระแพ็กเกจ คุณได้รับ {amount}', '{who} paid for a plan — you earned {amount}.'] },
  expiry: { s: ['ແພັກເກດ {plan} ຈະໝົດອາຍຸໃນ {days} ວັນ', 'แพ็กเกจ {plan} จะหมดอายุใน {days} วัน', 'Your {plan} plan expires in {days} day(s)'], h: ['ແພັກເກດໃກ້ໝົດອາຍຸ', 'แพ็กเกจใกล้หมดอายุ', 'Your plan is about to expire'],
    b: ['ແພັກເກດ {plan} ຈະໝົດອາຍຸວັນທີ {exp}. ຕໍ່ອາຍຸຕອນນີ້ເພື່ອບໍ່ໃຫ້ຮ້ານຖືກລັອກ.', 'แพ็กเกจ {plan} จะหมดอายุวันที่ {exp} ต่ออายุตอนนี้เพื่อไม่ให้ร้านถูกล็อก', 'Your {plan} plan expires on {exp}. Renew now to keep your shop running.'] },
  expired: { s: ['ແພັກເກດ {plan} ໝົດອາຍຸແລ້ວ', 'แพ็กเกจ {plan} หมดอายุแล้ว', 'Your {plan} plan has expired'], h: ['ແພັກເກດໝົດອາຍຸແລ້ວ', 'แพ็กเกจหมดอายุแล้ว', 'Your plan has expired'],
    b: ['ແພັກເກດ {plan} ໝົດອາຍຸເມື່ອ {exp}. ຕໍ່ອາຍຸເພື່ອກັບມາໃຊ້ງານເຕັມຮູບແບບ.', 'แพ็กเกจ {plan} หมดอายุเมื่อ {exp} ต่ออายุเพื่อกลับมาใช้งานเต็มรูปแบบ', 'Your {plan} plan expired on {exp}. Renew to get full access back.'] },
  test: { s: ['ທົດສອບອີເມວ Zelly', 'ทดสอบอีเมล Zelly', 'Zelly test email'], h: ['ການສົ່ງອີເມວໃຊ້ງານໄດ້', 'ระบบส่งอีเมลใช้งานได้', 'Email delivery works'],
    b: ['ຖ້າທ່ານເຫັນອີເມວນີ້ ແປວ່າການຕັ້ງຄ່າ SMTP ຖືກຕ້ອງ.', 'ถ้าคุณเห็นอีเมลนี้ แปลว่าตั้งค่า SMTP ถูกต้อง', 'If you can read this, your SMTP settings are correct.'] }
};
const IDX = { lo: 0, th: 1, en: 2 };
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => v[k] == null ? '' : v[k]);
const CTA = ['ເປີດ Zelly', 'เปิด Zelly', 'Open Zelly'];

function render(key, user, vars, extra) {
  const l = lg(user), i = IDX[l], t = T[key], v = Object.assign({ name: user && user.name || '' }, vars || {});
  const subject = fill(t.s[i], v), head = fill(t.h[i], v), body = fill(t.b[i], v), more = extra ? fill(extra[i], v) : '';
  const url = base();
  const text = [head, '', body, more, url ? '\n' + url : '', '\n— Zelly'].filter(x => x !== '').join('\n');
  const html = '<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:system-ui,-apple-system,Segoe UI,Roboto,Noto Sans Lao,Noto Sans Thai,sans-serif;color:#1d2433">'
    + '<div style="max-width:520px;margin:0 auto;padding:24px 16px"><div style="font-weight:800;font-size:20px;color:#4f46e5;margin:0 0 12px">Zelly</div>'
    + '<div style="background:#fff;border-radius:14px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.08)"><h2 style="margin:0 0 10px;font-size:18px">' + esc(head) + '</h2>'
    + '<p style="margin:0 0 10px;line-height:1.6;font-size:15px">' + esc(body) + '</p>' + (more ? '<p style="margin:0 0 10px;line-height:1.6;font-size:15px;color:#555">' + esc(more) + '</p>' : '')
    + (url ? '<p style="margin:18px 0 0"><a href="' + esc(url) + '" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600;display:inline-block">' + esc(CTA[i]) + '</a></p>' : '')
    + '</div><div style="text-align:center;font-size:12px;color:#8a90a0;margin-top:14px">Zelly · ' + esc(url || '') + '</div></div></body></html>';
  return { subject, text, html };
}
function to(user, key, vars, extra) {
  try { if (!user || !user.email || !Mail.enabled()) return false; const m = render(key, user, vars, extra); return Mail.send({ to: user.email, subject: m.subject, text: m.text, html: m.html }); }
  catch (e) { console.error('[notify]', key, e.message); return false; }
}
const toMany = (users, key, vars) => (users || []).forEach(u => to(u, key, vars));

module.exports = {
  render, to, enabled: Mail.enabled, money, pick,
  welcome: (u, pending) => to(u, 'welcome', {}, pending ? T.welcome.pend : null),
  order: (owner, o, shopName) => to(owner, 'order', { id: o.id, shop: shopName || '', cust: o.cust && o.cust.name || '', total: money(o.total) }),
  paid: (u, pay, plan, exp) => to(u, 'paid', { pay: pay.id, plan: pick(plan && plan.name, lg(u)), months: pay.months, amount: money(pay.amount), exp }),
  approved: (u, req, plan, exp) => to(u, 'approved', { req: req.id, plan: pick(plan && plan.name, lg(u)), exp }),
  rejected: (u, req) => to(u, 'rejected', { req: req.id }),
  slip: (admins, who, req, plan) => toMany(admins, 'slip', { who: who.biz || who.name || who.email, req: req.id, plan: pick(plan && plan.name, 'en'), amount: money(req.amount) }),
  payoutRequested: (admins, who, w) => toMany(admins, 'payreq', { who: who.biz || who.name || who.email, id: w.id, amount: money(w.amount), bank: w.bank }),
  payoutPaid: (u, w) => to(u, 'paypaid', { id: w.id, amount: money(w.amount) }),
  payoutRejected: (u, w) => to(u, 'payrej', { id: w.id, amount: money(w.amount) }),
  commission: (u, from, amount) => to(u, 'comm', { who: from.biz || from.name || '', amount: money(amount) }),
  expiry: (u, plan, exp, days) => to(u, days < 0 ? 'expired' : 'expiry', { plan: pick(plan && plan.name, lg(u)), exp, days }),
  test: u => to(u, 'test', {})
};
