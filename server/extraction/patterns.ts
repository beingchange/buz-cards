// Field patterns and normalisers. Pure functions: safe to use from tests, server and exports.

export const EMAIL_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._%+'-]*[A-Za-z0-9_-])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

export function isValidEmailSyntax(s: string): boolean {
  return EMAIL_RE.test(s) && !s.includes('..') && s.length <= 254;
}

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

/** Digits only, keeping a leading + when printed. Never adds a country code. */
export function normalizePhone(s: string): string {
  const plus = /^\s*(\+|00)/.test(s) ? '+' : '';
  let digits = s.replace(/\D/g, '');
  if (plus && s.trim().startsWith('00')) digits = digits.slice(2);
  return plus + digits;
}

/** Last 9 significant digits: tolerant match for duplicates (with/without country code or trunk 0). */
export function phoneMatchKey(s: string): string {
  const d = s.replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-9) : '';
}

export function normalizeWebsite(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Common top-level domains (plus country codes) accepted for bare domains like "acme.io".
const TLDS = new Set(
  (
    'com net org io co ai app biz info me tv us uk de fr it es nl be ch at se no dk fi ie pt pl cz sk hu ro bg gr tr ru ua ' +
    'ae sa qa kw om bh jo lb eg ma tn dz ng ke za gh et in pk bd lk np cn hk tw jp kr sg my id th vn ph au nz ca mx br ar cl ' +
    'pe co ve uy cr pa do pr is lu li mt cy ee lv lt si hr rs ba mk al md by kz uz az ge am il ir iq global group tech store ' +
    'shop online site solutions agency studio design digital cloud dev systems energy media network international email world coop bank law insurance consulting solar eco green earth city nyc llc inc build care health finance capital partners engineering services'
  ).split(' '),
);

export function hasKnownTld(domain: string): boolean {
  const parts = domain.toLowerCase().split('.');
  return parts.length >= 2 && TLDS.has(parts[parts.length - 1]);
}

export const PHONE_LABELS: [RegExp, string][] = [
  [/^(mobile|mob|cell|cellular|handy|gsm|m|c)$/i, 'mobile'],
  [/^(fax|f)$/i, 'fax'],
  [/^(direct|dir|d|dl|ddi)$/i, 'direct'],
  [/^(office|off|o|work|w|main|tel|tel\.|telephone|t|ph|phone|p)$/i, 'office'],
  [/^(home|h)$/i, 'home'],
  [/^(whatsapp|wa)$/i, 'mobile'],
];

export function phoneLabel(word: string | undefined): string | null {
  if (!word) return null;
  const w = word.replace(/[.:]/g, '').trim();
  for (const [re, label] of PHONE_LABELS) if (re.test(w)) return label;
  return null;
}

export const GENERIC_EMAIL_LOCALS =
  /^(info|sales|contact|office|hello|hi|admin|support|enquir(y|ies)|inquir(y|ies)|mail|team|general|reception|marketing|service|services|help|accounts?|billing|orders?|export|import|procurement|purchasing|hr|careers|jobs|noreply|no-reply)$/i;

// Job title vocabulary (English). Matching is word-based and case-insensitive.
export const TITLE_WORDS = new Set(
  (
    'manager managers director directors engineer engineers executive executives officer president vice vp svp evp avp head lead leader ' +
    'ceo cto cfo coo cmo cio ciso cpo cro founder co-founder cofounder partner partners principal architect designer consultant specialist ' +
    'coordinator analyst associate representative rep agent advisor adviser developer technician supervisor administrator assistant ' +
    'secretary professor lecturer attorney lawyer counsel accountant buyer merchandiser chairman chairwoman chairperson chair owner proprietor ' +
    'superintendent foreman scientist researcher strategist planner producer editor journalist photographer physician doctor surgeon nurse pharmacist ' +
    'dentist therapist trainer instructor teacher curator broker realtor underwriter auditor controller treasurer trustee ambassador evangelist ' +
    'intern apprentice expert estimator surveyor inspector geologist chemist programmer administrator officer'
  ).split(' '),
);
export const TITLE_MODIFIERS = new Set(
  'senior sr sr. junior jr jr. chief general regional area country global national international deputy assistant associate executive managing technical sales marketing business development operations product project account key purchasing procurement export import marketing'.split(
    ' ',
  ),
);

export const COMPANY_SUFFIX_RE =
  /\b(ltd|limited|llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|gmbh|ag|kg|sa|s\.a|sas|sarl|spa|s\.p\.a|srl|s\.r\.l|bv|b\.v|nv|oy|ab|as|a\/s|aps|pty|pvt|plc|llp|lp|pte|bhd|sdn|kk|k\.k|fzc|fze|fzco|wll|w\.l\.l|est|group|holdings?|industries|industrial|enterprises?|trading|solutions|systems|technologies|technology|tech|labs?|laboratories|logistics|engineering|capital|partners|associates|architects|interiors|analytics|consulting|consultants|services|international|manufacturing|fisheries|marine|robotics|solar|agro|pharma|pharmaceuticals|bank|university|institute|foundation|studio|studios|agency|media|motors|electronics|energy|construction|developers|realty|properties|hospitality|hotels?|resorts?|clinic|hospital|exports?|imports?|exim|ventures|networks|software|digital|design|foods?|textiles?|chemicals?|plastics?|metals?|steel|machinery|equipment|instruments|devices|medical|healthcare|insurance|finance|financial|investments?)\b\.?/i;

export const ADDRESS_WORDS_RE =
  /\b(street|st|road|rd|avenue|ave|av|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|square|sq|highway|hwy|parkway|pkwy|suite|ste|floor|fl|level|unit|office|building|bldg|tower|block|plot|p\.?\s?o\.?\s?box|po box|box|via|viale|piazza|corso|carrer|calle|avenida|rua|rue|chemin|straße|strasse|str|platz|weg|gasse|allee|plaza|park|quay|wharf|terrace|crescent|close|row|mews|industrial|estate|zone|area|sector|district|city|centre|center|mall|road|marg|nagar|colony|jalan|soi|khet|ward|bay|harbour|harbor|dock|dockside|port)\b\.?/i;

export const COUNTRIES_RE =
  /\b(united kingdom|uk|england|scotland|wales|ireland|united states|usa|u\.s\.a\.|canada|mexico|brazil|argentina|chile|germany|deutschland|france|italy|italia|spain|españa|portugal|netherlands|belgium|switzerland|austria|sweden|norway|denmark|finland|poland|czech republic|czechia|hungary|romania|greece|turkey|türkiye|russia|ukraine|uae|united arab emirates|saudi arabia|ksa|qatar|kuwait|oman|bahrain|jordan|lebanon|egypt|morocco|tunisia|algeria|nigeria|kenya|south africa|ghana|ethiopia|india|pakistan|bangladesh|sri lanka|nepal|china|p\.?r\.? china|hong kong|taiwan|japan|korea|south korea|singapore|malaysia|indonesia|thailand|vietnam|philippines|australia|new zealand)\b/i;

export const POSTCODE_RES = [
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/, // UK
  /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/, // US state + ZIP
  /\b\d{5}(-\d{4})?\b/, // 5-digit postal codes (many countries)
  /\b\d{4}\s?[A-Z]{2}\b/, // NL
  /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/, // CA
];

export function titleCaseWord(w: string) {
  return /^[A-Z][a-z'’\-À-ÿ]+$/.test(w);
}

export const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(
    ' ',
  ),
);
// Canadian provinces / Australian states share the "City, XX" pattern.
export const REGION_CODES = new Set([...US_STATES, ...'ON QC BC AB MB SK NS NB NL PE NSW VIC QLD WA SA TAS ACT NT'.split(' ')]);

/** "City, ST" or "City, ST 12345": typical North-American city line. */
export function cityStateLine(s: string): boolean {
  // The code must end the line or be followed only by a postcode, a separator or a country.
  const m = s.match(
    /\b\p{Lu}[\p{L}.'\- ]+,\s*([A-Z]{2,3})\.?\s*(\d{4,5}(?:-\d{4})?)?\s*(?:[|,]\s*(?:USA|U\.S\.A\.|US|United States|Canada|Australia)?\s*)?(?:$|\|)/u,
  );
  if (!m || !REGION_CODES.has(m[1])) return false;
  // Lists of state codes ("AL, AZ, CO, CT ...") are service-area lists, not addresses.
  return (s.match(/\b[A-Z]{2}\b/g) ?? []).filter((c) => REGION_CODES.has(c)).length < 3;
}

// Professional credentials / post-nominal letters that follow a name.
export const CREDENTIALS = new Set(
  (
    'PE P.E. P.E PENG P.ENG CENG EIT FE SE PLS LS PG RA AIA NCARB LEED AP BD+C O+M ID+C ND HOMES ENV SP GA CEM CEA CMVP CDSM CXA BCXP CCP CPHC HERS BPI CSI CDT ' +
    'RCDD PMP PMI-ACP CAPM CCM GPRO CTS CBCP DBIA CSP CIH CHMM REM CPESC CFM MBA MPA MPH MS MSC M.S. MSE MENG BENG BS BSC B.S. BA B.A. MA M.A. PHD PH.D PH.D. DPHIL ' +
    'EDD ED.D MD M.D. DO D.O. DDS DMD RN NP PA-C JD J.D. LLM ESQ ESQ. CPA CA ACCA CMA CFA CFP CAIA FRM CIPP CISSP CISA CISM CRISC CEH ITIL SHRM-CP SHRM-SCP PHR SPHR ' +
    'FRICS MRICS RICS CCIM SIOR CPM CRE ABR CRS GRI SRES JR JR. SR SR. II III IV'
  ).split(' '),
);

const CRED_NODOTS = new Set([...CREDENTIALS].map((c) => c.replace(/\./g, '')));

/** True for a credential token, including run-together ones from OCR ("P.E.CEM", "PEcEM" = PE + CEM). */
export function isCredentialToken(tok: string): boolean {
  const t = tok.replace(/[,;]+$/, '').toUpperCase();
  if (!t) return false;
  if (CREDENTIALS.has(t)) return true;
  const flat = t.replace(/[.,]/g, '');
  if (flat.length < 2 || flat.length > 14 || !/^[A-Z+\-]+$/.test(flat)) return false;
  // segment into known credentials (dynamic programming)
  const ok = new Array(flat.length + 1).fill(false);
  ok[0] = true;
  for (let i = 1; i <= flat.length; i++) for (let j = Math.max(0, i - 6); j < i && !ok[i]; j++) if (ok[j] && CRED_NODOTS.has(flat.slice(j, i))) ok[i] = true;
  return ok[flat.length];
}

/**
 * Split "Arun Mehra, PE, Ph.D, CEM" / "Owen Hartley MBA, CEM" into a name and post-nominal credentials.
 * Only tokens from the known credentials list are moved; anything else stays in the name.
 */
export function splitCredentials(s: string): { name: string; credentials: string } {
  const comma = s.indexOf(',');
  if (comma > 0) {
    const rest = s.slice(comma + 1).trim();
    const toks = rest.split(/[\s,]+/).filter(Boolean);
    if (toks.length && toks.filter(isCredentialToken).length >= Math.ceil(toks.length * 0.6)) {
      const head = splitCredentials(s.slice(0, comma).trim());
      const tail = rest.replace(/\s*,\s*/g, ', ').replace(/,\s*$/, '');
      return { name: head.name, credentials: head.credentials ? `${head.credentials}, ${tail}` : tail };
    }
  }
  const toks = s.split(/\s+/);
  let k = toks.length;
  while (k > 2 && isCredentialToken(toks[k - 1])) k--;
  if (k < toks.length) return { name: toks.slice(0, k).join(' ').replace(/,$/, ''), credentials: toks.slice(k).join(' ').replace(/,$/, '') };
  return { name: s, credentials: '' };
}

// Ordinary business/marketing words: a line made of these is a tagline or service list, not a person's name.
export const NON_NAME_WORDS = new Set(
  (
    'the and for of our your we you with in on at to by from new best trusted quality service services solution solutions system systems ' +
    'energy building buildings efficiency commercial residential healthcare education government pharmaceutical industrial analytics analysis ' +
    'automation integration integrators specification writing reporting indoor air consulting engineering construction management design ' +
    'development project projects sales marketing business technology technologies digital media group company corporation international ' +
    'global national regional local partner partners sustainability green power solar electric electrical mechanical plumbing heating cooling ' +
    'hvac lighting water environmental real estate realty properties property insurance financial finance capital investment investments bank ' +
    'credit union federal community communities initiative foundation institute university college school hospital clinic medical health care ' +
    'available emergency licensed certified registered professional engineers architects contractor contractors office main direct mobile cell ' +
    'phone fax email website www street road avenue suite floor city state york jersey island long north south east west high end low cost free ' +
    'premium product products inc llc ltd co corp gmbh division department team center centre audit audits assistance rebates installation ' +
    'proudly serves clients firm doing'
  ).split(' '),
);
