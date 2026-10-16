// Renders the fictional synthetic cards in tests/fixtures/synthetic/cards.json to flat PNGs.
// These are public regression fixtures only. They are NOT evidence of real-card accuracy.
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const cards = JSON.parse(await readFile(path.join(root, 'tests/fixtures/synthetic/cards.json'), 'utf8'));
const out = path.join(root, 'tests/fixtures/synthetic/flat');
await mkdir(out, { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function body(card, qr) {
  const t = card.truth;
  const [p1, p2, p3] = t.phones;
  const [e1, e2] = t.emails;
  const web = t.websites[0];
  switch (card.layout) {
    case 'classic':
      return `<div class="c" style="background:#fbfaf7;color:#1d2433;font-family:Carlito;padding:60px 70px">
        <div style="font:700 44px Caladea;color:#0b4f6c;letter-spacing:1px">${esc(t.company)}</div>
        <div style="height:4px;width:120px;background:#e0a100;margin:16px 0 50px"></div>
        <div style="font:700 50px Carlito">${esc(t.name)}</div>
        <div style="font:italic 30px Carlito;color:#555;margin-bottom:40px">${esc(t.title)}</div>
        <div style="font:26px Carlito;line-height:1.45">T ${esc(p1)}${p2 ? `&nbsp;&nbsp;&nbsp;M ${esc(p2)}` : ''}<br>${esc(e1)}<br>${esc(web)}<br><span style="font-size:22px;color:#666">${esc(t.address)}</span></div></div>`;
    case 'columns':
      return `<div class="c" style="background:#fff;color:#222;font-family:Inter;padding:70px 60px;display:flex;justify-content:space-between">
        <div><div style="font:600 46px Inter">${esc(t.name)}</div><div style="font:300 28px Inter;margin-top:8px">${esc(t.title)}</div>
        <div style="font:800 36px Inter;color:#5b2a86;margin-top:120px">${esc(t.company)}</div></div>
        <div style="text-align:right;font:24px Inter;line-height:1.6;padding-top:6px">${t.address.split(', ').slice(0, 2).map(esc).join('<br>')}<br>${esc(t.address.split(', ').slice(2).join(', '))}<br><br>${esc(p1)}<br>${esc(e1)}<br>${esc(web)}</div></div>`;
    case 'redpanel':
      return `<div class="c" style="display:flex;font-family:FreeSans">
        <div style="width:360px;background:#c8102e;color:#fff;display:flex;flex-direction:column;justify-content:center;padding:40px;font:700 50px FreeSans;line-height:1.05">${t.company.split(' ').map(esc).join('<br>')}</div>
        <div style="flex:1;background:#fff;color:#222;padding:60px 50px">
          <div style="font:700 44px FreeSans">${esc(t.name)}</div><div style="font:28px FreeSans;color:#c8102e;margin:6px 0 50px">${esc(t.title)}</div>
          <div style="font:24px FreeSans;line-height:1.55">${esc(p1)}<br>${esc(e1)}<br>${esc(e2)}<br>${esc(web)}<br>${esc(t.address)}</div></div></div>`;
    case 'dark':
      return `<div class="c" style="background:#14213d;color:#f1f1f1;font-family:'DejaVu Sans';padding:60px">
        <div style="font:bold 30px 'DejaVu Sans';color:#fca311;letter-spacing:3px">${esc(t.company.toUpperCase())}</div>
        <div style="margin-top:90px;font:bold 42px 'DejaVu Sans'">${esc(t.name)}</div><div style="font:26px 'DejaVu Sans';color:#cfd6e6">${esc(t.title)}</div>
        <div style="margin-top:40px;font:22px 'DejaVu Sans';line-height:1.6;columns:2">Tel ${esc(p1)}<br>Mob ${esc(p2)}<br>${esc(e1)}<br>${esc(web)}<br>${esc(t.address)}</div></div>`;
    case 'dense':
      return `<div class="c" style="background:#fff;color:#111;font-family:'Liberation Sans',FreeSans;padding:45px 55px">
        <div style="display:flex;justify-content:space-between;align-items:center"><div style="font:bold 40px FreeSerif;color:#00594f">${esc(t.company)}</div><div style="width:90px;height:90px;border-radius:50%;background:#00594f"></div></div>
        <div style="font:bold 36px FreeSans;margin-top:30px">${esc(t.name)}</div><div style="font:22px FreeSans">${esc(t.title)}</div>
        <div style="font:19px FreeSans;line-height:1.5;margin-top:26px">Tel: ${esc(p1)} &nbsp; Fax: ${esc(p3)}<br>Mobile: ${esc(p2)}<br>Email: ${esc(e1)}<br>${esc(e2)} &nbsp; | &nbsp; ${esc(web)}<br>${esc(t.address)}</div></div>`;
    case 'minimal':
      return `<div class="c" style="background:#f4f1ea;color:#222;font-family:'GFS Baskerville',FreeSerif;padding:80px;text-align:center">
        <div style="font:34px FreeSerif;letter-spacing:6px">${esc(t.company.toUpperCase())}</div>
        <div style="font:44px FreeSerif;margin-top:80px">${esc(t.name)}</div><div style="font:italic 26px FreeSerif">${esc(t.title)}</div>
        <div style="font:22px FreeSerif;margin-top:50px">${esc(p1)} · ${esc(e1)} · ${esc(web)}<br>${esc(t.address)}</div></div>`;
    case 'icons':
      return `<div class="c" style="background:linear-gradient(90deg,#0f9d58 0 26px,#fff 26px);color:#333;font-family:Inter;padding:60px 60px 60px 90px">
        <div style="font:800 40px Inter;color:#0f9d58">${esc(t.company)}</div>
        <div style="font:600 40px Inter;margin-top:60px">${esc(t.name)}</div><div style="font:26px Inter;color:#666">${esc(t.title)}</div>
        <div style="font:23px 'DejaVu Sans';line-height:1.6;margin-top:30px">☎ ${esc(p1)}<br>✉ ${esc(e1)}<br>⌂ ${esc(web)}<br>in ${esc(t.linkedin)}<br><span style="font-size:20px">${esc(t.address)}</span></div></div>`;
    case 'qr':
      return `<div class="c" style="background:#fff;color:#1b1b1b;font-family:Inter;padding:60px;display:flex;gap:50px">
        <div style="flex:1"><div style="font:800 36px Inter;color:#2d5bff">${esc(t.company)}</div>
        <div style="font:700 42px Inter;margin-top:70px">${esc(t.name)}</div><div style="font:26px Inter">${esc(t.title)}</div>
        <div style="font:22px Inter;line-height:1.6;margin-top:30px">${esc(p1)}<br>${esc(e1)}<br>${esc(web)}<br>${esc(t.address)}</div></div>
        <img src="${qr}" style="width:260px;height:260px;align-self:center"></div>`;
    case 'caps':
      return `<div class="c" style="background:#fff;color:#000;font-family:FreeSerif;padding:70px;border:18px solid #7a1f1f">
        <div style="font:bold 30px FreeSerif;letter-spacing:4px;color:#7a1f1f">${esc(t.company.toUpperCase())}</div>
        <div style="font:bold 44px FreeSans;letter-spacing:5px;margin-top:70px">${esc(t.name)}</div><div style="font:italic 26px FreeSerif">${esc(t.title)}</div>
        <div style="font:22px FreeSans;margin-top:40px;line-height:1.5">${esc(t.address)}<br>T ${esc(p1)} &nbsp; E ${esc(e1)} &nbsp; ${esc(web)}</div></div>`;
    case 'lowcontrast':
      return `<div class="c" style="background:#fdfdfd;color:#9a9a9a;font-family:Inter;padding:70px">
        <div style="font:200 46px Inter;color:#8a8a8a">${esc(t.company.toLowerCase())}</div>
        <div style="font:400 40px Inter;color:#777;margin-top:80px">${esc(t.name)}</div><div style="font:300 24px Inter">${esc(t.title)}</div>
        <div style="font:300 21px Inter;margin-top:40px;line-height:1.6">${esc(p1)} &nbsp; ${esc(e1)}<br>${esc(web)} &nbsp; ${esc(t.address)}</div></div>`;
    case 'sideline':
      return `<div class="c" style="background:#fffaf0;color:#2b2b2b;font-family:Carlito;padding:60px">
        <div style="font:bold 40px Caladea;color:#b5651d">${esc(t.company)}</div>
        <div style="display:flex;justify-content:space-between;margin-top:80px;font:bold 40px Carlito"><span>${esc(t.name)}</span><span style="font:24px Carlito">${esc(p1)}</span></div>
        <div style="display:flex;justify-content:space-between;font:26px Carlito"><span>${esc(t.title)}</span><span style="font:24px Carlito">${esc(p2)}</span></div>
        <div style="font:24px Carlito;margin-top:50px;line-height:1.5">${esc(e1)} &nbsp;&nbsp; ${esc(web)}<br>${esc(t.address)}</div></div>`;
    default:
      throw new Error(card.layout);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1050, height: 600 } });
for (const card of cards) {
  const t = card.truth;
  const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${t.name}`, `ORG:${t.company}`, `EMAIL:${t.emails[0]}`, `URL:${t.linkedin ?? ''}`, 'END:VCARD'].join('\n');
  const qr = await QRCode.toDataURL(vcard, { margin: 1, width: 400 });
  await page.setContent(
    `<html><head><style>body{margin:0}.c{width:1050px;height:600px;box-sizing:border-box;overflow:hidden}</style></head><body>${body(card, qr)}</body></html>`,
  );
  await page.waitForTimeout(50);
  await page.screenshot({ path: path.join(out, `${card.id}.png`) });
}
await browser.close();
console.log(`rendered ${cards.length} cards to ${out}`);
