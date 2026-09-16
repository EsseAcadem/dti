import { writeFile } from 'node:fs/promises';

const API_KEY = process.env.SKILLS_ENGLAND_API_KEY;
if (!API_KEY) {
  throw new Error('Missing SKILLS_ENGLAND_API_KEY GitHub secret.');
}

const API_URL = new URL('https://occupational-maps-api.skillsengland.education.gov.uk/api/v1/digital');
API_URL.searchParams.set(
  'expand',
  [
    'occupation.overview',
    'occupation.summary',
    'occupation.typicaljobtitles',
    'occupation.keywords',
    'occupation.dutiesKSB',
    'occupation.products'
  ].join(',')
);

const ACADEMY_EMAIL = 'gstt.DTIAcademy@nhs.net';
const ALLOWED_LEVELS = new Set([3, 4, 5, 6]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function text(value) {
  return value == null ? '' : String(value).trim();
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripHtml(value = '') {
  return decodeHtmlEntities(
    String(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function directEntries(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.entries(obj) : [];
}

function getDirect(obj, keyPatterns) {
  for (const [key, value] of directEntries(obj)) {
    if (keyPatterns.some(pattern => pattern.test(key))) return value;
  }
  return undefined;
}

function findDirectReference(obj, prefix) {
  const preferred = getDirect(obj, [/reference/i, /standard.*code/i, /^code$/i]);
  const candidates = [preferred, ...directEntries(obj).map(([, value]) => value)];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const match = candidate.match(new RegExp(`\\b${prefix}\\d{4}\\b`, 'i'));
    if (match) return match[0].toUpperCase();
  }
  return '';
}

function collectStrings(node, keyPattern, output = []) {
  if (node == null) return output;
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, keyPattern, output);
    return output;
  }
  if (typeof node !== 'object') return output;

  for (const [key, value] of Object.entries(node)) {
    if (keyPattern.test(key)) {
      if (typeof value === 'string') output.push(stripHtml(value));
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') output.push(stripHtml(item));
          else if (item && typeof item === 'object') {
            for (const nested of Object.values(item)) {
              if (typeof nested === 'string') output.push(stripHtml(nested));
            }
          }
        }
      }
    }
    if (value && typeof value === 'object') collectStrings(value, keyPattern, output);
  }
  return output;
}

function unique(values) {
  return [...new Set(values.map(v => text(v)).filter(Boolean))];
}

function truncate(value, max = 260) {
  const clean = stripHtml(value);
  if (clean.length <= max) return clean;
  const shortened = clean.slice(0, max - 1).replace(/\s+\S*$/, '');
  return `${shortened}…`;
}

function firstSentences(value, count = 2, max = 420) {
  const clean = stripHtml(value);
  if (!clean) return '';
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  return truncate(sentences.slice(0, count).join(' ').trim(), max);
}

function scalarSearch(obj, keyRegex) {
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (keyRegex.test(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
        found.push(String(value));
      }
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(obj);
  return found;
}

function findTitle(obj, fallback = '') {
  const value = getDirect(obj, [/^title$/i, /^name$/i, /occupation.*title/i, /product.*name/i]);
  return truncate(value || fallback, 110);
}

function findLevel(obj) {
  const values = scalarSearch(obj, /level/i);
  for (const value of values) {
    const match = String(value).match(/(?:level\s*)?([2-7])\b/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function findOccupationText(occupation, kind) {
  const patterns = {
    overview: [/overview/i, /role.*overview/i],
    summary: [/summary/i, /occupation.*description/i],
    keywords: [/keyword/i],
    jobs: [/job.*title/i, /typical.*title/i],
    ksb: [/knowledge/i, /skill/i, /behaviour/i, /duty/i, /ksb/i]
  };
  return unique(collectStrings(occupation, new RegExp(patterns[kind].map(r => r.source).join('|'), 'i')));
}

function collectProducts(apiData) {
  const found = [];

  function walk(node, occupationContext = null) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, occupationContext);
      return;
    }

    const occupationRef = findDirectReference(node, 'OCC');
    const nextOccupation = occupationRef ? node : occupationContext;

    const apprenticeshipRef = findDirectReference(node, 'ST');
    if (apprenticeshipRef) {
      found.push({
        reference: apprenticeshipRef,
        product: node,
        occupation: nextOccupation || occupationContext || {}
      });
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, nextOccupation);
    }
  }

  walk(apiData);

  // A reference can appear in links as well as the actual product object. Keep the richest object.
  const byReference = new Map();
  for (const item of found) {
    const current = byReference.get(item.reference);
    const score = JSON.stringify(item.product).length + JSON.stringify(item.occupation).length;
    if (!current || score > current.score) byReference.set(item.reference, { ...item, score });
  }

  return [...byReference.values()].map(({ score, ...item }) => item);
}


function extractApiDetails(item) {
  const product = item.product || {};
  const statusValues = scalarSearch(product, /status|state|availability|available|paused|retired|withdrawn|development/i);
  const versionValues = scalarSearch(product, /version/i);
  const durationValues = scalarSearch(product, /duration/i);
  const fundingValues = scalarSearch(product, /fund/i);

  const status = statusValues.join(' | ');
  const level = findLevel(product) || findLevel(item.occupation);

  let durationMonths = null;
  for (const value of durationValues) {
    const match = String(value).match(/(\d+)\s*(?:months?)?/i);
    if (match) { durationMonths = Number(match[1]); break; }
  }

  let maximumFunding = null;
  for (const value of fundingValues) {
    const match = String(value).replace(/,/g, '').match(/(\d{3,})/);
    if (match) { maximumFunding = Number(match[1]); break; }
  }

  const version = versionValues.map(String).find(v => /^\d+(?:\.\d+)*$/.test(v.trim())) || '';

  return {
    reference: item.reference,
    status,
    level,
    version,
    durationMonths,
    maximumFunding,
    route: 'Digital',
    overview: findOccupationText(item.occupation, 'overview')[0] || '',
    url: `https://skillsengland.education.gov.uk/apprenticeships/${item.reference.toLowerCase()}`,
    plain: status
  };
}

function mergeDetails(primary, fallback) {
  return {
    reference: primary.reference || fallback.reference,
    status: primary.status || fallback.status,
    level: primary.level || fallback.level,
    version: primary.version || fallback.version,
    durationMonths: primary.durationMonths || fallback.durationMonths,
    maximumFunding: primary.maximumFunding || fallback.maximumFunding,
    route: primary.route || fallback.route,
    overview: primary.overview || fallback.overview,
    url: primary.url || fallback.url,
    plain: `${primary.plain || ''} ${fallback.plain || ''}`.trim()
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Skills England API returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function fetchStandardPage(reference) {
  const url = `https://skillsengland.education.gov.uk/apprenticeships/${reference.toLowerCase()}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'DTI-Connect-Apprenticeship-Refresh/1.0'
    }
  });
  if (!response.ok) throw new Error(`${reference}: standard page returned ${response.status}`);
  const html = await response.text();
  return { url, html, plain: stripHtml(html) };
}

function extractPageDetails(reference, page) {
  const plain = page.plain;

  const statusMatch = plain.match(/Status:\s*(.*?)\s+(?:Level:|Reference:)/i);
  const levelMatch = plain.match(/Level:\s*([2-7])\b/i);
  const versionMatch = plain.match(/Version:\s*([0-9.]+)/i);
  const durationMatch = plain.match(/Typical duration(?: to gateway)?:\s*(\d+)\s*months?/i);
  const fundingMatch = plain.match(/Maximum funding:\s*£\s*([\d,]+)/i);
  const routeMatch = plain.match(/Route:\s*([^:]{1,80}?)(?=\s+(?:Typical duration|Integration|Maximum funding|Date updated|Approved for delivery):)/i);
  const overviewMatch = plain.match(/Overview of the role\s+(.*?)(?=\s+(?:Occupation summary|Details of standard|Occupational standard|End-point assessment summary))/i);

  return {
    reference,
    status: text(statusMatch?.[1]),
    level: levelMatch ? Number(levelMatch[1]) : null,
    version: text(versionMatch?.[1]),
    durationMonths: durationMatch ? Number(durationMatch[1]) : null,
    maximumFunding: fundingMatch ? Number(fundingMatch[1].replace(/,/g, '')) : null,
    route: text(routeMatch?.[1]),
    overview: truncate(overviewMatch?.[1] || '', 300),
    url: page.url,
    plain
  };
}

function isAvailableForStarts(details) {
  const status = details.status.toLowerCase();
  const wholePage = details.plain.toLowerCase();

  if (!status.includes('approved for delivery')) return false;
  if (/retired|withdrawn|paused for starts|standard in development|proposal in development/.test(status)) return false;

  // Some pages use a shorter "Approved for delivery" status. Reject explicit warning states elsewhere.
  if (/this apprenticeship has been retired|status:\s*retired|approved for delivery \(paused for starts\)/.test(wholePage)) return false;

  return true;
}

function buildLearnBullets(occupation) {
  const ksb = findOccupationText(occupation, 'ksb')
    .map(item => truncate(item, 170))
    .filter(item => item.length >= 18);

  if (ksb.length) return unique(ksb).slice(0, 4);

  return [
    'The knowledge, skills and behaviours set out in the current Skills England occupational standard',
    'How to apply the standard through day-to-day work and workplace projects',
    'Provider-led learning alongside protected learning time at work',
    'How to prepare for the apprenticeship assessment requirements'
  ];
}

function buildTags(item, details, title) {
  const keywords = findOccupationText(item.occupation, 'keywords').slice(0, 8);
  const jobs = findOccupationText(item.occupation, 'jobs').slice(0, 4);
  const titleWords = title
    .replace(/[^a-z0-9+#. ]/gi, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 3)
    .slice(0, 6);

  return unique([
    'Digital',
    'IT',
    'Apprenticeship',
    'Levy',
    'Free',
    `Level ${details.level}`,
    details.reference,
    ...titleWords,
    ...keywords,
    ...jobs
  ]).slice(0, 24);
}

function buildCard(item, details) {
  const occupationTitle = findTitle(item.occupation);
  const productTitle = findTitle(item.product);
  const baseTitle = productTitle || occupationTitle || details.reference;
  const titleWithoutLevel = baseTitle.replace(/\s+[—-]\s+Level\s+[2-7]\s*$/i, '').trim();

  const overview = findOccupationText(item.occupation, 'overview')[0] || details.overview;
  const summary = findOccupationText(item.occupation, 'summary')[0];

  return {
    title: `${titleWithoutLevel} — Level ${details.level}`,
    section: 'apprenticeship',
    tags: buildTags(item, details, titleWithoutLevel),
    isForMe: overview || `People whose role aligns with the ${titleWithoutLevel} occupational standard.`,
    involve: firstSentences(summary || overview || `A work-based Level ${details.level} apprenticeship aligned to the Skills England ${details.reference} standard.`),
    learn: buildLearnBullets(item.occupation),
    delivery: 'Work-based apprenticeship',
    duration: details.durationMonths ? `${details.durationMonths} months` : 'Duration TBC',
    cost: 'Levy-funded (Free)',
    how: `E-mail ${ACADEMY_EMAIL}`,
    skillsEngland: {
      reference: details.reference,
      version: details.version,
      status: details.status,
      maximumFunding: details.maximumFunding,
      url: details.url
    }
  };
}

console.log('Fetching Digital route from Skills England…');
const apiData = await fetchJson(API_URL, {
  headers: {
    'X-API-KEY': API_KEY,
    'Accept': 'application/json'
  }
});

const products = collectProducts(apiData);
if (!products.length) {
  throw new Error('No apprenticeship products were found in the Digital route API response. The API schema may have changed.');
}

console.log(`Found ${products.length} Digital-route ST references. Validating current availability…`);
const cards = [];
const failures = [];

for (const item of products) {
  try {
    let details = extractApiDetails(item);

    // The route API is the main source. If it does not expose enough detail for a
    // safe availability decision, use the public Skills England standard page as
    // a secondary official source rather than guessing.
    const apiStatusIsDecisive = /approved for delivery|retired|withdrawn|paused|development|proposal/i.test(details.status);
    const needsPage = !apiStatusIsDecisive || !details.level || !details.durationMonths;

    if (needsPage) {
      const page = await fetchStandardPage(item.reference);
      details = mergeDetails(details, extractPageDetails(item.reference, page));
      await sleep(120);
    }

    if (!details.level || !ALLOWED_LEVELS.has(details.level)) continue;
    if (!isAvailableForStarts(details)) continue;

    cards.push(buildCard(item, details));
  } catch (error) {
    failures.push(String(error?.message || error));
  }
}

cards.sort((a, b) => {
  const levelA = Number(a.skillsEngland?.level || a.title.match(/Level\s+(\d+)/i)?.[1] || 99);
  const levelB = Number(b.skillsEngland?.level || b.title.match(/Level\s+(\d+)/i)?.[1] || 99);
  return levelA - levelB || a.title.localeCompare(b.title, 'en-GB');
});

if (!cards.length) {
  throw new Error(`No currently available Level 3-6 Digital apprenticeships survived validation. Failures: ${failures.slice(0, 5).join(' | ')}`);
}

// Guard against accidentally publishing a badly parsed response.
if (cards.length < 5) {
  throw new Error(`Only ${cards.length} apprenticeships were generated. Refusing to overwrite the last known-good catalogue.`);
}

await writeFile('apprenticeships.json', `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
console.log(`Wrote ${cards.length} current Digital apprenticeships to apprenticeships.json.`);
if (failures.length) console.warn(`Skipped ${failures.length} standards because their detail pages could not be parsed.`);
