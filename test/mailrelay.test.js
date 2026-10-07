import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendViaRelay } from '../server/mailrelay.js';

// Lažni Apps Script: POST /exec preusmjeri (302) na /echo, kao pravi Google.
let server, base, last;
before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/exec') {
        last = JSON.parse(data);
        res.writeHead(302, { Location: '/echo' }).end();
      } else if (req.method === 'GET' && req.url === '/echo') {
        const ok = last.key === 'tajna';
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(ok ? { ok: true, preostaloDanas: 99 } : { ok: false, error: 'Pogrešan ključ' }));
      } else if (req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Prijava</html>');
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('šalje mail preko skripte i prati preusmjeravanje', async () => {
  const out = await sendViaRelay({
    to: 'ana@example.com', subject: 'Termin', html: '<p>Bok</p>', text: 'Bok', replyTo: 'b@example.com', name: 'BSB',
    attachments: [{ filename: 'termin.ics', content: 'BEGIN:VCALENDAR\nČ', contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }],
  }, { url: `${base}/exec`, key: 'tajna' });
  assert.equal(out.ok, true);
  assert.equal(last.to, 'ana@example.com');
  assert.equal(last.replyTo, 'b@example.com');
  assert.equal(last.attachments[0].contentType, 'text/calendar');
  assert.equal(Buffer.from(last.attachments[0].content, 'base64').toString('utf8'), 'BEGIN:VCALENDAR\nČ');
});

test('pogrešan ključ baca grešku', async () => {
  await assert.rejects(sendViaRelay({ to: 'a@b.c', subject: 's', html: 'h' }, { url: `${base}/exec`, key: 'kriva' }), /Pogrešan ključ/);
});

test('odgovor koji nije JSON daje jasnu poruku', async () => {
  await assert.rejects(sendViaRelay({ to: 'a@b.c', subject: 's', html: 'h' }, { url: `${base}/html`, key: 'tajna' }), /web-aplikacija/);
});
