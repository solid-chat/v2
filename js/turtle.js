// A small Turtle reader and writer for chat files. Reads the Turtle that Solid servers and
// SolidOS produce (prefixes, lists, blank nodes, typed and tagged literals, long strings)
// into plain triples, and escapes what we write back. Not a full N3 parser: no
// quoted formulas, no variables, no paths.

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';

// A parsed term: { type: 'iri' | 'bnode' | 'literal', value, datatype?, lang? }.
export const iri = (value) => ({ type: 'iri', value });
export const literal = (value, datatype, lang) => ({ type: 'literal', value, ...(datatype ? { datatype } : {}), ...(lang ? { lang } : {}) });

export function resolveIri(ref, base) {
  if (!base) return ref;
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

const UNESCAPE = { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\' };
function unescapeString(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gs, (m, e) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (e in UNESCAPE) return UNESCAPE[e];
    throw new Error(`Bad escape \\${e}`);
  });
}

// Parse a Turtle document. Returns [{ s, p, o }]: s and p are strings (IRIs, or '_:x' for
// blank nodes), o is a term. `base` resolves relative IRIs and is overridden by @base.
export function parseTurtle(text, base = '') {
  const triples = [];
  const prefixes = new Map();
  let pos = 0;
  let blankCount = 0;
  const fail = (what) => {
    const line = text.slice(0, pos).split('\n').length;
    throw new Error(`Turtle: ${what} at line ${line}`);
  };
  const skip = () => {
    for (;;) {
      const m = /^(?:\s+|#[^\n]*)/.exec(text.slice(pos));
      if (!m) return;
      pos += m[0].length;
    }
  };
  const peek = () => (skip(), text[pos]);
  const eat = (s) => {
    skip();
    if (!text.startsWith(s, pos)) fail(`expected ${s}`);
    pos += s.length;
  };
  const match = (re) => {
    skip();
    re.lastIndex = pos;
    const m = re.exec(text);
    if (m) pos = re.lastIndex;
    return m;
  };
  const bnode = () => `_:b${blankCount++}`;
  const term = (s) => (s.startsWith('_:') ? { type: 'bnode', value: s } : iri(s));
  const expandPrefixed = (name) => {
    const colon = name.indexOf(':');
    const prefix = name.slice(0, colon);
    const local = name.slice(colon + 1).replace(/\\(.)/g, '$1');
    if (!prefixes.has(prefix)) fail(`unknown prefix ${prefix}:`);
    return prefixes.get(prefix) + local;
  };
  // IRI or blank node label, as a string. Returns null when nothing matches.
  const nodeRef = () => {
    let m = match(/<([^<>"{}|^`\\\x00-\x20]*)>/y);
    if (m) return resolveIri(unescapeString(m[1]), base);
    m = match(/_:([\p{L}\p{N}_][\p{L}\p{N}_.\-]*)/uy);
    if (m) return `_:${m[1]}`;
    m = match(/((?:[\p{L}][\p{L}\p{N}_.\-]*)?):((?:[\p{L}\p{N}_:%]|\\.|-|\.(?=[^\s.;,\])]))*)/uy);
    if (m) return expandPrefixed(m[0]);
    return null;
  };
  const literalTerm = () => {
    let m = match(/"""((?:[^"\\]|\\.|"(?!""))*)"""|'''((?:[^'\\]|\\.|'(?!''))*)'''|"((?:[^"\\\n\r]|\\.)*)"|'((?:[^'\\\n\r]|\\.)*)'/sy);
    if (m) {
      const value = unescapeString(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
      let suffix = match(/\^\^/y);
      if (suffix) {
        const dt = nodeRef();
        if (!dt || dt.startsWith('_:')) fail('bad datatype');
        return literal(value, dt);
      }
      suffix = match(/@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*)/y);
      if (suffix) return literal(value, undefined, suffix[1].toLowerCase());
      return literal(value);
    }
    m = match(/[+-]?(?:\d+\.\d*[eE][+-]?\d+|\.\d+[eE][+-]?\d+|\d+[eE][+-]?\d+)/y);
    if (m) return literal(m[0], `${XSD}double`);
    m = match(/[+-]?(?:\d*\.\d+)/y);
    if (m) return literal(m[0], `${XSD}decimal`);
    m = match(/[+-]?\d+(?![\p{L}:])/uy);
    if (m) return literal(m[0], `${XSD}integer`);
    m = match(/(true|false)(?![\p{L}\p{N}_:])/uy);
    if (m) return literal(m[1], `${XSD}boolean`);
    return null;
  };
  const object = () => {
    const c = peek();
    if (c === '[') {
      eat('[');
      const id = bnode();
      if (peek() !== ']') predicateObjectList(id);
      eat(']');
      return { type: 'bnode', value: id };
    }
    if (c === '(') {
      eat('(');
      const items = [];
      while (peek() !== ')') items.push(object());
      eat(')');
      if (!items.length) return iri(RDF_NIL);
      const ids = items.map(() => bnode());
      items.forEach((item, i) => {
        triples.push({ s: ids[i], p: RDF_FIRST, o: item });
        triples.push({ s: ids[i], p: RDF_REST, o: i + 1 < ids.length ? { type: 'bnode', value: ids[i + 1] } : iri(RDF_NIL) });
      });
      return { type: 'bnode', value: ids[0] };
    }
    const lit = literalTerm();
    if (lit) return lit;
    const ref = nodeRef();
    if (ref === null) fail('expected an object');
    return term(ref);
  };
  const predicate = () => {
    if (match(/a(?![\p{L}\p{N}_:\-])/uy)) return RDF_TYPE;
    const ref = nodeRef();
    if (ref === null || ref.startsWith('_:')) fail('expected a predicate');
    return ref;
  };
  const predicateObjectList = (subject) => {
    for (;;) {
      const p = predicate();
      for (;;) {
        triples.push({ s: subject, p, o: object() });
        if (peek() !== ',') break;
        eat(',');
      }
      if (peek() !== ';') return;
      while (peek() === ';') eat(';');
      if (peek() === '.' || peek() === ']' || pos >= text.length) return;
    }
  };
  const directive = () => {
    let m = match(/(?:@prefix|PREFIX)(?![\p{L}\p{N}_])/uy);
    if (m) {
      const sparql = m[0] === 'PREFIX';
      const name = match(/((?:[\p{L}][\p{L}\p{N}_.\-]*)?):/uy);
      if (!name) fail('expected a prefix name');
      const ref = match(/<([^<>"{}|^`\\\x00-\x20]*)>/y);
      if (!ref) fail('expected a prefix IRI');
      prefixes.set(name[1], resolveIri(unescapeString(ref[1]), base));
      if (!sparql) eat('.');
      return true;
    }
    m = match(/(?:@base|BASE)(?![\p{L}\p{N}_])/uy);
    if (m) {
      const ref = match(/<([^<>"{}|^`\\\x00-\x20]*)>/y);
      if (!ref) fail('expected a base IRI');
      base = resolveIri(unescapeString(ref[1]), base);
      if (m[0] === '@base') eat('.');
      return true;
    }
    return false;
  };
  while ((skip(), pos < text.length)) {
    if (directive()) continue;
    let subject;
    const c = text[pos];
    if (c === '[') {
      eat('[');
      subject = bnode();
      if (peek() !== ']') predicateObjectList(subject);
      eat(']');
      if (peek() === '.') {
        eat('.');
        continue;
      }
    } else if (c === '(') {
      subject = object().value;
    } else {
      const ref = nodeRef();
      if (ref === null) fail('expected a subject');
      subject = ref;
    }
    predicateObjectList(subject);
    eat('.');
  }
  return triples;
}

// ---------- Writing ----------

export function escapeString(value) {
  return value.replace(/[\\"\n\r\t]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]);
}

export const writeIri = (value) => `<${value.replace(/[<>"{}|^`\\\x00-\x20]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}>`;

// A term as Turtle (full IRIs only, so no prefix table is needed).
export function writeTerm(t) {
  if (typeof t === 'string') return t.startsWith('_:') ? t : writeIri(t);
  if (t.type === 'iri') return writeIri(t.value);
  if (t.type === 'bnode') return t.value;
  const body = `"${escapeString(t.value)}"`;
  if (t.lang) return `${body}@${t.lang}`;
  if (t.datatype && t.datatype !== `${XSD}string`) return `${body}^^${writeIri(t.datatype)}`;
  return body;
}

export const writeTriple = ({ s, p, o }) => `${writeTerm(s)} ${writeTerm(p)} ${writeTerm(o)} .`;

// ---------- Querying parsed triples ----------

export const objectsOf = (triples, s, p) => triples.filter((t) => t.s === s && t.p === p).map((t) => t.o);
export const valueOf = (triples, s, p) => objectsOf(triples, s, p)[0]?.value;
export const subjectsOf = (triples, p, o) => triples.filter((t) => t.p === p && t.o.value === o).map((t) => t.s);

// ---------- JSON-LD (the subset Solid servers store and serve) ----------
// JSS keeps resources as compacted JSON-LD: a @context of prefix strings (plus a few
// aliases), a single node or a @graph, values as strings, { "@id" }, { "@value", "@type" }
// or { "@value", "@language" }. Expanding that subset to triples needs no library.

function expandJsonLdIri(value, context, base) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('_:')) return value;
  const colon = value.indexOf(':');
  if (colon > 0 && !value.startsWith('//', colon + 1)) {
    const prefix = value.slice(0, colon);
    const ns = context[prefix];
    if (typeof ns === 'string') return ns + value.slice(colon + 1);
  }
  const alias = context[value];
  if (alias && typeof alias === 'object' && typeof alias['@id'] === 'string') return expandJsonLdIri(alias['@id'], context, base);
  if (typeof alias === 'string') return expandJsonLdIri(alias, context, base);
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : resolveIri(value, base);
}

export function parseJsonLd(doc, base = '') {
  const triples = [];
  const docs = Array.isArray(doc) ? doc : [doc];
  let context = {};
  for (const d of docs) if (d && typeof d['@context'] === 'object' && !Array.isArray(d['@context'])) context = { ...context, ...d['@context'] };
  const nodes = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    if (Array.isArray(d['@graph'])) nodes.push(...d['@graph']);
    if (d['@id'] !== undefined || d.id !== undefined) nodes.push(d);
  }
  let blank = 0;
  const value = (v, key) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') {
      if (Array.isArray(v)) return null;
      if (v['@value'] !== undefined) {
        const dt = v['@type'] ? expandJsonLdIri(v['@type'], context, base) : undefined;
        return literal(String(v['@value']), dt, v['@language']);
      }
      const id = v['@id'] ?? v.id;
      if (typeof id === 'string') {
        if (Object.keys(v).some((k) => k !== '@id' && k !== 'id')) nodes.push(v);
        return iri(expandJsonLdIri(id, context, base));
      }
      return null;
    }
    const alias = context[key];
    if (alias && typeof alias === 'object' && alias['@type'] === '@id' && typeof v === 'string') return iri(expandJsonLdIri(v, context, base));
    if (typeof v === 'boolean') return literal(String(v), `${XSD}boolean`);
    if (typeof v === 'number') return literal(String(v), Number.isInteger(v) ? `${XSD}integer` : `${XSD}double`);
    return literal(String(v));
  };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const rawId = node['@id'] ?? node.id;
    const s = typeof rawId === 'string' ? (rawId.startsWith('_:') ? rawId : expandJsonLdIri(rawId, context, base)) : `_:j${blank++}`;
    const types = node['@type'] ?? node.type;
    for (const t of Array.isArray(types) ? types : types ? [types] : []) if (typeof t === 'string') triples.push({ s, p: RDF_TYPE, o: iri(expandJsonLdIri(t, context, base)) });
    for (const [key, raw] of Object.entries(node)) {
      if (key.startsWith('@') || key === 'id' || key === 'type') continue;
      const p = expandJsonLdIri(key, context, base);
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        const o = value(v, key);
        if (o) triples.push({ s, p, o });
      }
    }
  }
  return triples;
}

// Parse a fetched RDF document by its content type (Turtle, N3 or JSON-LD).
export function parseRdf(text, contentType, base) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type.includes('json')) return parseJsonLd(JSON.parse(text), base);
  return parseTurtle(text, base);
}
