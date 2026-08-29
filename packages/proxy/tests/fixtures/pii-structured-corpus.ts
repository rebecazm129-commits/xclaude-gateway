// Corpus for pii_structured (28/08 cleanup). Every string is synthetic or a
// de-identified reconstruction of a real-trail false positive — booking IDs
// are INVENTED mod-11-valid values (the real CSV contains client names and is
// deliberately NOT copied), emails and card numbers are documented test
// vectors.
//
// NOISE_CORPUS — machine numbers from the real trail that passed a foreign
// checksum by chance (mod-11 lets ~9% of random digit runs through, Luhn 10%).
// None of these may yield ANY finding.
export const NOISE_CORPUS: readonly string[] = [
  // ps aux rows: VSZ column, 9 and 10 digits (elfproef / NHS mod-11 pass):
  'rebecazambranomoreno 87552  0,0  0,0 435299360    560 ??  S    dom.03p. m.   0:00.00 /Applications/Claude.app/Contents/Helpers/disclaimer',
  'rebecazambranomoreno 87798  0,0  0,2 1949114384  29696 ??  S    dom.03p. m.   0:00.73 /Applications/xCLAUDE Gateway.app/Contents/MacOS/xCLAUDE Gateway',
  // Booking CSV with INVENTED reservation ids (900100102 passes the Dutch
  // elfproef, 900200103 the Portuguese mod-11 — verified when authoring):
  '6,23/7/26 9:00,900100102,-,Mantenimiento diseño,Cliente Ejemplo,10.00 €\n7,23/7/26 9:20,900200103,-,Labio,Otra Clienta Ejemplo,3.00 €',
  // Release-JSON file size (passes the Portuguese mod-11):
  '"content_type":"application/x-apple-diskimage","size":208990461,"download_count":3',
  // Epoch milliseconds (13 digits, Luhn-valid by chance):
  '"t1": 1784380046237, "tReturn": 1784380046274, "update": 180',
  // Long decimal fraction (17 digits after the point, Luhn-valid run):
  '"frame_duration_ms_min": 0.21766700000000583,',
  // ULID decode value (13 digits, Luhn-valid, first digit 4):
  'ulid=03QCKSTZ000000000000000000 decode=4102358400000 roundtrip=true',
  // base64 blob fragment that passes IBAN mod-97 ("FN…" is no country code):
  '8L/jZ4Z8O6d4q1PxJ4U8SWF04h1W8F21vPAC26OQAYB6EfX0GADv/in8ZNP+FN14egvtL1LUTrN19mjawi3iI8ct6/eHyjnrT2Ap',
  // Functional email:
  'Co-Authored-By: Claude <noreply@anthropic.com>',
];

// REAL_CORPUS — labelled, checksum-valid identifiers that MUST keep firing
// with the given finding type. Digit-only formats carry their standard
// context keyword, as real documents do.
export const REAL_CORPUS: ReadonlyArray<{ text: string; type: string }> = [
  { text: 'BSN: 111222333', type: 'nl_bsn' },
  { text: 'NIF 123456789', type: 'pt_nif' },
  { text: 'NHS Number: 943 476 5919', type: 'uk_nhs' },
  { text: 'card 4111 1111 1111 1111', type: 'credit_card' },
  { text: 'IBAN DE89 3704 0044 0532 0130 00', type: 'iban' },
  { text: 'DNI 12345678Z', type: 'es_dni' },
  { text: 'contact maria.garcia@dominio-personal.com', type: 'email' },
  { text: 'call +34612345678', type: 'phone_e164' },
];
