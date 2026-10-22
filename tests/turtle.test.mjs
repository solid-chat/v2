import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTurtle, parseJsonLd, parseRdf, writeTriple, writeTerm, literal, iri, RDF_TYPE, XSD } from '../js/turtle.js';

const base = 'https://pod.example/alice/chats/lobby/2026/10/22/chat.ttl';
const S = (f) => `${base}#${f}`;

test('parses prefixes, the a keyword, lists of predicates and objects', () => {
  const t = parseTurtle(`@prefix : <#>.
@prefix dc: <http://purl.org/dc/elements/1.1/>.
@prefix meeting: <http://www.w3.org/ns/pim/meeting#>.
:this a meeting:LongChat; dc:title "Lobby", "Hall" .`, base);
  assert.deepEqual(t, [
    { s: S('this'), p: RDF_TYPE, o: iri('http://www.w3.org/ns/pim/meeting#LongChat') },
    { s: S('this'), p: 'http://purl.org/dc/elements/1.1/title', o: literal('Lobby') },
    { s: S('this'), p: 'http://purl.org/dc/elements/1.1/title', o: literal('Hall') },
  ]);
});

test('reads every literal form a chat file can carry', () => {
  const t = parseTurtle(`PREFIX sioc: <http://rdfs.org/sioc/ns#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
<#a> sioc:content """multi
line "quoted" \\\\ back""" ; sioc:n 42, 3.5, 1e3, true, -7 ;
  sioc:when "2026-10-22T10:00:00Z"^^xsd:dateTime ; sioc:lang "hi"@en-GB ; sioc:esc "tab\\tnl\\n\\u00e9" .`, base);
  const o = (p) => t.filter((x) => x.p === `http://rdfs.org/sioc/ns#${p}`).map((x) => x.o);
  assert.equal(o('content')[0].value, 'multi\nline "quoted" \\ back');
  assert.deepEqual(o('n').map((x) => [x.value, x.datatype.replace(XSD, '')]), [['42', 'integer'], ['3.5', 'decimal'], ['1e3', 'double'], ['true', 'boolean'], ['-7', 'integer']]);
  assert.deepEqual(o('when')[0], literal('2026-10-22T10:00:00Z', `${XSD}dateTime`));
  assert.deepEqual(o('lang')[0], literal('hi', undefined, 'en-gb'));
  assert.equal(o('esc')[0].value, 'tab\tnl\né');
});

test('resolves relative IRIs against the document and honours @base', () => {
  const t = parseTurtle(`<> <http://x/p> <2026/10/23/chat.ttl>, <../../../index.ttl#this>, <#m1> .
@base <http://ex.org/dir/> .
<doc> <http://x/p> <other> .`, base);
  assert.deepEqual(t.map((x) => x.o.value), [
    'https://pod.example/alice/chats/lobby/2026/10/22/2026/10/23/chat.ttl',
    'https://pod.example/alice/chats/lobby/index.ttl#this',
    S('m1'),
    'http://ex.org/dir/other',
  ]);
  assert.equal(t[0].s, base);
  assert.equal(t[3].s, 'http://ex.org/dir/doc');
});

test('blank nodes, collections and comments', () => {
  const t = parseTurtle(`# a comment
<#b> <http://x/p> [ <http://x/q> "nested" ], ( "one" <#c> ) . # trailing
[] <http://x/r> "anon" .`, base);
  assert.equal(t.length, 8);
  assert.ok(t.every((x) => !x.s.startsWith('_:') || /^_:b\d+$/.test(x.s)));
  assert.equal(t.filter((x) => x.o.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil').length, 1);
});

test('rejects what it cannot read instead of guessing', () => {
  assert.throws(() => parseTurtle('<#a> <http://x/p> .', base), /expected an object/);
  assert.throws(() => parseTurtle('<#a> ex:p "x" .', base), /unknown prefix/);
});

test('writes escaped literals and full IRIs that parse back identically', () => {
  const triple = { s: S('m1'), p: 'http://rdfs.org/sioc/ns#content', o: literal('line\n"q"\\ tab\t end') };
  const text = writeTriple(triple);
  assert.equal(text, `<${S('m1')}> <http://rdfs.org/sioc/ns#content> "line\\n\\"q\\"\\\\ tab\\t end" .`);
  assert.deepEqual(parseTurtle(text), [triple]);
  assert.equal(writeTerm(literal('2026-10-22T10:00:00Z', `${XSD}dateTime`)), '"2026-10-22T10:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>');
  assert.equal(writeTerm(literal('hi', undefined, 'en')), '"hi"@en');
  assert.equal(writeTerm(iri('http://x/a b')), '<http://x/a\\u0020b>');
});

test('expands the JSON-LD subset Solid servers store (context prefixes, @graph, typed values)', () => {
  const doc = {
    '@context': { dc: 'http://purl.org/dc/terms/', foaf: 'http://xmlns.com/foaf/0.1/', xsd: 'http://www.w3.org/2001/XMLSchema#', storage: { '@id': 'http://www.w3.org/ns/pim/space#storage', '@type': '@id' } },
    '@graph': [
      { '@id': 'https://pod.example/alice/chats/lobby/index.ttl#this', 'http://www.w3.org/2005/01/wf/flow#message': [{ '@id': '#m1' }] },
      { '@id': '#m1', 'dc:created': { '@value': '2026-10-22T10:00:00Z', '@type': 'xsd:dateTime' }, 'http://rdfs.org/sioc/ns#content': 'hello', 'foaf:maker': { '@id': 'did:nostr:' + 'a'.repeat(64) }, storage: '/alice/', 'dc:title': { '@value': 'x', '@language': 'en' } },
    ],
  };
  const t = parseJsonLd(doc, base);
  const m = t.filter((x) => x.s === S('m1'));
  assert.deepEqual(m.find((x) => x.p === 'http://purl.org/dc/terms/created').o, literal('2026-10-22T10:00:00Z', `${XSD}dateTime`));
  assert.deepEqual(m.find((x) => x.p === 'http://xmlns.com/foaf/0.1/maker').o, iri('did:nostr:' + 'a'.repeat(64)));
  assert.deepEqual(m.find((x) => x.p === 'http://www.w3.org/ns/pim/space#storage').o, iri('https://pod.example/alice/'));
  assert.deepEqual(m.find((x) => x.p === 'http://purl.org/dc/terms/title').o, literal('x', undefined, 'en'));
  assert.equal(t[0].o.value, S('m1'));
  assert.equal(parseRdf(JSON.stringify(doc), 'application/ld+json; charset=utf-8', base).length, t.length);
  assert.equal(parseRdf('<#a> <http://x/p> "y" .', 'text/turtle', base).length, 1);
});
