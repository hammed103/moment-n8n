const crypto = require('crypto');
const https = require('https');
const creds = require('./peak-lattice-398418-eeb02e45c896.json');
const SHEET_ID = '15nZGf7Sk8dVrKllalK8Dk6tq7yK8Z6Dr_jPODFEtI84';
function createJWT() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({ iss: creds.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  return header + '.' + claim + '.' + sign.sign(creds.private_key, 'base64url');
}
function httpReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function main() {
  const jwt = createJWT();
  const tokenRes = await httpReq({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt);
  const token = tokenRes.access_token;

  function findDups(arr) {
    const seen = new Set();
    const dups = [];
    for (const u of arr) {
      if (seen.has(u)) dups.push(u);
      else seen.add(u);
    }
    return [...new Set(dups)];
  }

  // Profiles
  const profRes = await httpReq({ hostname: 'sheets.googleapis.com', path: '/v4/spreadsheets/' + SHEET_ID + '/values/Profiles!A:A', method: 'GET', headers: { Authorization: 'Bearer ' + token } });
  const profUsernames = (profRes.values || []).slice(1).map(r => (r[0] || '').toLowerCase().trim());
  const profDups = findDups(profUsernames);
  console.log('=== PROFILES ===');
  console.log('Total:', profUsernames.length, '| Unique:', new Set(profUsernames).size);
  if (profDups.length > 0) console.log('DUPLICATES:', profDups.join(', '));
  else console.log('No duplicates');

  // Classified Leads
  const clRes = await httpReq({ hostname: 'sheets.googleapis.com', path: '/v4/spreadsheets/' + SHEET_ID + '/values/Classified%20Leads!A:A', method: 'GET', headers: { Authorization: 'Bearer ' + token } });
  const clUsernames = (clRes.values || []).slice(1).map(r => (r[0] || '').toLowerCase().trim());
  const clDups = findDups(clUsernames);
  console.log('\n=== CLASSIFIED LEADS ===');
  console.log('Total:', clUsernames.length, '| Unique:', new Set(clUsernames).size);
  if (clDups.length > 0) console.log('DUPLICATES:', clDups.join(', '));
  else console.log('No duplicates');

  // Relevant Leads
  const rlRes = await httpReq({ hostname: 'sheets.googleapis.com', path: '/v4/spreadsheets/' + SHEET_ID + '/values/Relevant%20Leads!A:A', method: 'GET', headers: { Authorization: 'Bearer ' + token } });
  const rlUsernames = (rlRes.values || []).slice(1).map(r => (r[0] || '').toLowerCase().trim());
  const rlDups = findDups(rlUsernames);
  console.log('\n=== RELEVANT LEADS ===');
  console.log('Total:', rlUsernames.length, '| Unique:', new Set(rlUsernames).size);
  if (rlDups.length > 0) console.log('DUPLICATES:', rlDups.join(', '));
  else console.log('No duplicates');
}
main();
