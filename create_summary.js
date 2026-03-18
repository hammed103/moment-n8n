const crypto = require('crypto');
const https = require('https');

const creds = require('./peak-lattice-398418-eeb02e45c896.json');
const SHEET_ID = '15nZGf7Sk8dVrKllalK8Dk6tq7yK8Z6Dr_jPODFEtI84';

function createJWT() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  const signature = sign.sign(creds.private_key, 'base64url');
  return header + '.' + claim + '.' + signature;
}

function httpReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const jwt = createJWT();
  const tokenRes = await httpReq({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt);
  const token = tokenRes.data.access_token;

  // Check if Summary sheet exists
  const infoRes = await httpReq({
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET_ID + '?fields=sheets.properties',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token }
  });
  const sheets = infoRes.data.sheets.map(s => s.properties.title);

  if (!sheets.includes('Summary')) {
    const addRes = await httpReq({
      hostname: 'sheets.googleapis.com',
      path: '/v4/spreadsheets/' + SHEET_ID + ':batchUpdate',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    }, JSON.stringify({
      requests: [{
        addSheet: {
          properties: { title: 'Summary', index: 0 }
        }
      }]
    }));
    console.log('Created Summary sheet:', addRes.status);
  }

  // Column references:
  // Profiles: A=username, E=follower_count, F=following_count, G=post_count, H=is_verified, I=is_business, J=business_category, K=external_url, M=email_in_bio, N=phone_in_bio, O=engagement_rate, AD=seed_account, AE=seed_type
  // Classified Leads: A=username, R=classification, S=confidence, X=net_worth_tier, AC=priority_score, P=seed_account
  // Relevant Leads: A=username, C=classification, D=priority_score, E=confidence, U=email_in_bio, V=phone_in_bio, W=external_url, AA=seed_account

  const rows = [
    ['PIPELINE OVERVIEW', '', '', ''],
    ['Metric', 'Value', '', ''],
    ['Total Scraped Profiles', '=COUNTA(Profiles!A:A)-1', '', ''],
    ['Total Classified', '=COUNTA(\'Classified Leads\'!A:A)-1', '', ''],
    ['Unclassified (Pending)', '=MAX(0,(COUNTA(Profiles!A:A)-1)-(COUNTA(\'Classified Leads\'!A:A)-1))', '', ''],
    ['Classification Progress %', '=IF(COUNTA(Profiles!A:A)-1>0,(COUNTA(\'Classified Leads\'!A:A)-1)/(COUNTA(Profiles!A:A)-1),0)', '', ''],
    ['Total Relevant Leads', '=COUNTA(\'Relevant Leads\'!A:A)-1', '', ''],
    ['Relevance Rate %', '=IF(COUNTA(\'Classified Leads\'!A:A)-1>0,(COUNTA(\'Relevant Leads\'!A:A)-1)/(COUNTA(\'Classified Leads\'!A:A)-1),0)', '', ''],
    ['', '', '', ''],

    ['CLASSIFICATION BREAKDOWN', '', '', ''],
    ['Classification', 'Count', '% of Total', ''],
    ['Collector', '=COUNTIF(\'Classified Leads\'!R:R,"collector")', '=IF(B4>0,B12/B4,0)', ''],
    ['Dealer', '=COUNTIF(\'Classified Leads\'!R:R,"dealer")', '=IF(B4>0,B13/B4,0)', ''],
    ['Enthusiast', '=COUNTIF(\'Classified Leads\'!R:R,"enthusiast")', '=IF(B4>0,B14/B4,0)', ''],
    ['Media/Influencer', '=COUNTIF(\'Classified Leads\'!R:R,"media")+COUNTIF(\'Classified Leads\'!R:R,"influencer")', '=IF(B4>0,B15/B4,0)', ''],
    ['Irrelevant', '=COUNTIF(\'Classified Leads\'!R:R,"irrelevant")', '=IF(B4>0,B16/B4,0)', ''],
    ['Error/Unknown', '=COUNTIF(\'Classified Leads\'!R:R,"error")+COUNTIF(\'Classified Leads\'!R:R,"unknown")', '=IF(B4>0,B17/B4,0)', ''],
    ['', '', '', ''],

    ['PROFILE STATISTICS', '', '', ''],
    ['Metric', 'Value', '', ''],
    ['Avg Follower Count', '=IF(COUNTA(Profiles!A:A)>1,ROUND(AVERAGE(Profiles!E2:E),0),0)', '', ''],
    ['Median Follower Count', '=IF(COUNTA(Profiles!A:A)>1,ROUND(MEDIAN(Profiles!E2:E),0),0)', '', ''],
    ['Avg Post Count', '=IF(COUNTA(Profiles!A:A)>1,ROUND(AVERAGE(Profiles!G2:G),0),0)', '', ''],
    ['Verified Accounts', '=COUNTIF(Profiles!H:H,TRUE)', '', ''],
    ['Business Accounts', '=COUNTIF(Profiles!I:I,TRUE)', '', ''],
    ['Has Email in Bio', '=COUNTIFS(Profiles!M2:M,"<>")', '', ''],
    ['Has Phone in Bio', '=COUNTIFS(Profiles!N2:N,"<>")', '', ''],
    ['Has External URL', '=COUNTIFS(Profiles!K2:K,"<>")', '', ''],
    ['', '', '', ''],

    ['RELEVANT LEADS QUALITY', '', '', ''],
    ['Metric', 'Value', '', ''],
    ['Avg Priority Score', '=IF(COUNTA(\'Relevant Leads\'!A:A)>1,ROUND(AVERAGE(\'Relevant Leads\'!D2:D),1),0)', '', ''],
    ['Max Priority Score', '=IF(COUNTA(\'Relevant Leads\'!A:A)>1,MAX(\'Relevant Leads\'!D2:D),0)', '', ''],
    ['High Priority (Score >= 7)', '=COUNTIFS(\'Relevant Leads\'!D2:D,">="&7)', '', ''],
    ['Medium Priority (4-6.9)', '=COUNTIFS(\'Relevant Leads\'!D2:D,">="&4,\'Relevant Leads\'!D2:D,"<"&7)', '', ''],
    ['Low Priority (< 4)', '=COUNTIFS(\'Relevant Leads\'!D2:D,"<"&4,\'Relevant Leads\'!D2:D,">"&0)', '', ''],
    ['', '', '', ''],

    ['NET WORTH DISTRIBUTION', '', '', ''],
    ['Tier', 'Count', '', ''],
    ['Ultra High Net Worth', '=COUNTIF(\'Classified Leads\'!X:X,"*ultra*")', '', ''],
    ['High Net Worth', '=COUNTIF(\'Classified Leads\'!X:X,"*high*")-COUNTIF(\'Classified Leads\'!X:X,"*ultra*")', '', ''],
    ['Medium Net Worth', '=COUNTIF(\'Classified Leads\'!X:X,"*medium*")+COUNTIF(\'Classified Leads\'!X:X,"*moderate*")', '', ''],
    ['Unknown/Other', '=MAX(0,B4-B39-B40-B41)', '', ''],
    ['', '', '', ''],

    ['CONTACTABLE RELEVANT LEADS', '', '', ''],
    ['Metric', 'Value', '', ''],
    ['With Email', '=COUNTIFS(\'Relevant Leads\'!U2:U,"<>")', '', ''],
    ['With Phone', '=COUNTIFS(\'Relevant Leads\'!V2:V,"<>")', '', ''],
    ['With External URL', '=COUNTIFS(\'Relevant Leads\'!W2:W,"<>")', '', ''],
    ['With Any Contact Info', '=SUMPRODUCT(((\'Relevant Leads\'!U2:U<>"")*1+(\'Relevant Leads\'!V2:V<>"")*1+(\'Relevant Leads\'!W2:W<>"")*1)>0)', '', ''],
    ['', '', '', ''],

    ['SEED ACCOUNT PERFORMANCE', '', '', ''],
    ['Seed Account', 'Profiles Scraped', 'Classified', 'Relevant Leads'],
    // Using UNIQUE to auto-list seed accounts from Profiles
  ];

  // Write main data
  const updateRes = await httpReq({
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET_ID + '/values/Summary!A1?valueInputOption=USER_ENTERED',
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  }, JSON.stringify({
    range: 'Summary!A1',
    majorDimension: 'ROWS',
    values: rows
  }));
  console.log('Updated Summary:', updateRes.status);

  // Now add the dynamic seed account list using UNIQUE + SORT
  // Row 53 is where seed data starts (after the header row at 52)
  const seedFormulas = [
    ['=IFERROR(SORT(UNIQUE(Profiles!AD2:AD)),"")', '=ARRAYFORMULA(IF(A53:A="","",COUNTIF(Profiles!AD:AD,A53:A)))', '=ARRAYFORMULA(IF(A53:A="","",COUNTIF(\'Classified Leads\'!P:P,A53:A)))', '=ARRAYFORMULA(IF(A53:A="","",COUNTIF(\'Relevant Leads\'!AA:AA,A53:A)))'],
  ];

  const seedRes = await httpReq({
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET_ID + '/values/Summary!A53?valueInputOption=USER_ENTERED',
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  }, JSON.stringify({
    range: 'Summary!A53',
    majorDimension: 'ROWS',
    values: seedFormulas
  }));
  console.log('Added seed formulas:', seedRes.status);

  // Format: make percentage cells formatted as %
  // Get Summary sheet ID first
  const sheetInfo = await httpReq({
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET_ID + '?fields=sheets.properties',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token }
  });
  const summarySheet = sheetInfo.data.sheets.find(s => s.properties.title === 'Summary');
  const summarySheetId = summarySheet.properties.sheetId;

  // Apply formatting
  const formatRes = await httpReq({
    hostname: 'sheets.googleapis.com',
    path: '/v4/spreadsheets/' + SHEET_ID + ':batchUpdate',
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  }, JSON.stringify({
    requests: [
      // Bold section headers
      ...[0, 9, 18, 29, 37, 43, 50].map(row => ({
        repeatCell: {
          range: { sheetId: summarySheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, backgroundColor: { red: 0.2, green: 0.4, blue: 0.7 }, horizontalAlignment: 'LEFT' } },
          fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)'
        }
      })),
      // Bold sub-headers
      ...[1, 10, 19, 30, 38, 44, 51].map(row => ({
        repeatCell: {
          range: { sheetId: summarySheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }
      })),
      // White text on blue headers
      ...[0, 9, 18, 29, 37, 43, 50].map(row => ({
        repeatCell: {
          range: { sheetId: summarySheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12, foregroundColor: { red: 1, green: 1, blue: 1 } }, backgroundColor: { red: 0.2, green: 0.4, blue: 0.7 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)'
        }
      })),
      // Format percentage cells (B6, B8)
      {
        repeatCell: {
          range: { sheetId: summarySheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 },
          cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      },
      {
        repeatCell: {
          range: { sheetId: summarySheetId, startRowIndex: 7, endRowIndex: 8, startColumnIndex: 1, endColumnIndex: 2 },
          cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      },
      // Format % column in classification breakdown (C12:C17)
      {
        repeatCell: {
          range: { sheetId: summarySheetId, startRowIndex: 11, endRowIndex: 17, startColumnIndex: 2, endColumnIndex: 3 },
          cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      },
      // Set column widths
      {
        updateDimensionProperties: {
          range: { sheetId: summarySheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 260 },
          fields: 'pixelSize'
        }
      },
      {
        updateDimensionProperties: {
          range: { sheetId: summarySheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 180 },
          fields: 'pixelSize'
        }
      },
      {
        updateDimensionProperties: {
          range: { sheetId: summarySheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
          properties: { pixelSize: 140 },
          fields: 'pixelSize'
        }
      },
      {
        updateDimensionProperties: {
          range: { sheetId: summarySheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
          properties: { pixelSize: 140 },
          fields: 'pixelSize'
        }
      },
    ]
  }));
  console.log('Applied formatting:', formatRes.status);

  console.log('Done! Summary sheet created with live formulas.');
}
main().catch(console.error);
