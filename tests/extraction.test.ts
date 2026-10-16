// Field extraction on hand-built OCR line layouts (no images). Fictional data only.
import { describe, expect, it } from 'vitest';
import { extractFields, findPhones, parseQr } from '../server/extraction/fields.ts';
import { splitCredentials, isCredentialToken, cityStateLine, normalizePhone } from '../server/extraction/patterns.ts';
import { chooseReading, unionSpaces, ligatureRecovery } from '../server/recognition/consensus.ts';
import type { OcrLineDTO } from '../shared/types.ts';

let n = 0;
function line(text: string, x: number, y: number, w: number, h: number, readings?: string[], conf = 0.99): OcrLineDTO {
  const id = `l${n++}`;
  return {
    id,
    text,
    confidence: conf,
    box: { x, y, w, h },
    disputed: false,
    readings: (readings ?? [text]).map((t, i) => ({
      text: t,
      confidence: conf,
      source: i === 0 ? 'ppocrv5-mobile' : i === 1 ? 'en-ppocrv4' : 'ppocrv5-mobile-upscaled',
    })),
  };
}
const run = (lines: OcrLineDTO[], qr: string[] = []) => extractFields({ lines, qr, width: 1800, height: 1000 });

describe('layout extraction', () => {
  it('separates a name and an address printed on the same row (columns)', () => {
    const ex = run([
      line('Priya Raman', 60, 60, 420, 70),
      line('500 Howard Street', 1200, 60, 480, 50),
      line('Head of Partnerships', 60, 140, 520, 50),
      line('Suite 300', 1420, 120, 260, 50),
      line('San Francisco, CA 94105', 1080, 180, 600, 50),
      line('priya.raman@kestrelanalytics.io', 1000, 380, 680, 50),
      line('Kestrel Analytics', 60, 400, 480, 60),
    ]);
    expect(ex.name.value).toBe('Priya Raman');
    expect(ex.title.value).toBe('Head of Partnerships');
    expect(ex.company.value).toBe('Kestrel Analytics');
    expect(ex.address.value).toBe('500 Howard Street, Suite 300, San Francisco, CA 94105');
    expect(ex.emails.map((e) => e.value)).toEqual(['priya.raman@kestrelanalytics.io']);
  });

  it('joins stacked company lines and stacked names', () => {
    const ex = run([
      line('Vortex', 120, 440, 330, 110),
      line('Pump', 120, 540, 315, 130),
      line('Systems', 115, 655, 450, 130),
      line('MILO', 1000, 100, 300, 120),
      line('KASPER', 1000, 230, 450, 120),
      line('STRATEGIC SALES', 1000, 420, 600, 70),
      line('DIRECTOR', 1000, 500, 360, 64),
      line('milo@vortexpumps.it', 1000, 700, 600, 60),
    ]);
    expect(ex.company.value).toBe('Vortex Pump Systems');
    expect(ex.name.value).toBe('MILO KASPER');
    expect(ex.title.value).toBe('STRATEGIC SALES DIRECTOR');
  });

  it('moves credentials out of the name, including run-together OCR tokens', () => {
    expect(splitCredentials('Arun Mehra, PE, Ph.D, CEM')).toEqual({ name: 'Arun Mehra', credentials: 'PE, Ph.D, CEM' });
    expect(splitCredentials('Owen Hartley MBA, CEM')).toEqual({ name: 'Owen Hartley', credentials: 'MBA, CEM' });
    expect(isCredentialToken('P.E.CEM')).toBe(true);
    expect(isCredentialToken('PEcEM')).toBe(true);
    expect(splitCredentials('Maria de la Cruz').credentials).toBe('');
  });

  it('never treats ZIP+4, licence numbers or address digits as phone numbers', () => {
    expect(findPhones('New York, NY 10001-3473')).toEqual([]);
    expect(findPhones('NY FA&SA # 12000287881')).toEqual([]);
    expect(findPhones('(M2) (929) 555-0116').map((p) => [p.value, p.label])).toEqual([['(929) 555-0116', 'mobile']]);
    expect(findPhones('(0) (917)555-0187').map((p) => p.label)).toEqual(['office']);
    expect(findPhones('P (908) 555-0150 Ext 224').map((p) => p.value)).toEqual(['(908) 555-0150 Ext 224']);
    expect(findPhones('+1 929.555.0174 Direct').map((p) => p.label)).toEqual(['direct']);
  });

  it('keeps the printed phone format and never adds a country code', () => {
    const ex = run([line('Dana Kim', 60, 60, 400, 70), line('Tel: 020 7946 0321', 60, 200, 500, 50), line('dana@example-firm.co.uk', 60, 280, 600, 50)]);
    expect(ex.phones[0].value).toBe('020 7946 0321');
    expect(ex.phones[0].normalized).toBe('02079460321');
    expect(normalizePhone('+44 20 7946 0321')).toBe('+442079460321');
  });

  it('flags an e-mail when the two models disagree and offers the other reading', () => {
    const ex = run([
      line('Dana Delgado', 60, 60, 400, 70),
      line('danadelgado@orbital.energy', 60, 300, 700, 60, ['danadelgado@orbital.energy', 'danadelgado@orbita1.energy']),
    ]);
    expect(ex.emails[0].meta.state).toBe('needs_review');
    expect(ex.emails[0].meta.alternatives).toContain('danadelgado@orbita1.energy');
  });

  it('resolves an e-mail disagreement only with evidence printed elsewhere on the card', () => {
    const ex = run([
      line('Lena Park', 60, 60, 300, 70),
      line('www.lumacoinc.com', 60, 200, 500, 50),
      line('lena@lumacoine.com', 60, 300, 600, 50, ['lena@lumacoine.com', 'lena@lumacoinc.com', 'lena@lumacoine.com']),
    ]);
    expect(ex.emails[0].value).toBe('lena@lumacoinc.com');
    expect(ex.emails[0].meta.state).toBe('extracted');
  });

  it('flags an e-mail domain and website that differ only by look-alike letters', () => {
    const ex = run([line('Tomas Ferreira', 60, 60, 400, 70), line('www.tideiot.com', 60, 200, 500, 50), line('tomas@tidelot.com', 60, 300, 600, 50)]);
    expect(ex.emails[0].meta.state).toBe('needs_review');
    expect(ex.websites[0].meta.state).toBe('needs_review');
  });

  it('does not invent a name for a card back (service list)', () => {
    const ex = run([
      line('Commercial | Education | Government', 200, 60, 1300, 100),
      line('Healthcare | High-end Residential | Pharmaceutical', 40, 180, 1700, 100),
      line('• Building Automation', 100, 400, 600, 80, ['•Building Automation']),
      line('HALVORSEN', 170, 800, 560, 100),
      line('(888) 555-0178', 1000, 810, 480, 90),
      line('Building Automation Solutions', 240, 890, 480, 50),
    ]);
    expect(ex.name.value).toBe('');
    expect(ex.phones.map((p) => p.value)).toEqual(['(888) 555-0178']);
  });

  it('reads vCard / MECARD QR codes and labels other QR links', () => {
    const v = parseQr('BEGIN:VCARD\nVERSION:3.0\nN:Brandt;Noah\nFN:Noah Brandt\nORG:Kestrel Labs\nTEL;CELL:9175550236\nEMAIL;WORK:noah@example.com\nEND:VCARD');
    expect(v).toMatchObject({ name: 'Noah Brandt', org: 'Kestrel Labs', emails: ['noah@example.com'] });
    const ex = run([line('Noah Brandt', 60, 60, 400, 70)], ['https://calendly.com/someone/30min']);
    expect(ex.websites[0].label).toBe('qr-link');
  });

  it('accepts a city line only when the region code ends the line', () => {
    expect(cityStateLine('Brooklyn, NY')).toBe(true);
    expect(cityStateLine('New York, NY 10018')).toBe(true);
    expect(cityStateLine('Marco Ellis, PE, PMP')).toBe(false);
    expect(cityStateLine('MA, MD, ME, MI, NJ, NV')).toBe(false);
  });
});

describe('reading consensus', () => {
  it('merges spacing from equivalent readings without splitting e-mails', () => {
    expect(unionSpaces(['Astoria, NY11106', 'Astoria,NY 11106'])).toBe('Astoria, NY 11106');
    expect(unionSpaces(['J.R.Whitfield', 'J. R. Whitfield'])).toBe('J. R. Whitfield');
    expect(unionSpaces(['john@spring.bank', 'john @spring. bank'])).toBe('john@spring.bank');
  });
  it('recovers letters swallowed by fi/fl ligatures', () => {
    expect(ligatureRecovery('offcer', 'officer')).toBe(true);
    expect(ligatureRecovery('whitfeldcrane', 'whitfieldcrane')).toBe(true);
    expect(ligatureRecovery('orbital', 'orbita1')).toBe(false);
  });
  it('prefers the reading made of real words when models disagree', () => {
    const c = chooseReading(
      [
        { text: 'Lumaco Solurion & Services Inc.', confidence: 0.97, source: 'ppocrv5-mobile' },
        { text: 'Lumaco Solution & Services Inc.', confidence: 0.96, source: 'en-ppocrv4' },
        { text: 'Lumaco Solurion & Services Inc.', confidence: 0.97, source: 'ppocrv5-mobile-upscaled' },
      ],
      'ppocrv5-mobile',
    );
    expect(c.text).toBe('Lumaco Solution & Services Inc.');
  });
});
