// E.164 calling code -> ISO2 country, by LONGEST PREFIX match.
//
// Needed because Meta reports cost per COUNTRY but the status webhook that
// tells us which message was billed carries only the recipient's number. Without
// this, every message would be costed at the day's blended rate — and on this
// account that blend spans India utility at Rs 0.1150 and Germany utility at
// Rs 4.0322, a 35x spread that would misattribute cost between templates.
//
// Deliberately NOT exhaustive. An unmapped number returns null, which the rate
// lookup handles by falling back to the blended rate — a slightly less precise
// number, never a wrong country. Ambiguous codes (+1 US/CA, +7 RU/KZ) resolve
// to the larger market; splitting them needs area codes, which is more
// machinery than the accuracy is worth here.

const CODES = {
  // Longest first is handled by the lookup, not by ordering here.
  1: 'US', 7: 'RU', 20: 'EG', 27: 'ZA', 30: 'GR', 31: 'NL', 32: 'BE', 33: 'FR',
  34: 'ES', 36: 'HU', 39: 'IT', 40: 'RO', 41: 'CH', 43: 'AT', 44: 'GB', 45: 'DK',
  46: 'SE', 47: 'NO', 48: 'PL', 49: 'DE', 51: 'PE', 52: 'MX', 53: 'CU', 54: 'AR',
  55: 'BR', 56: 'CL', 57: 'CO', 58: 'VE', 60: 'MY', 61: 'AU', 62: 'ID', 63: 'PH',
  64: 'NZ', 65: 'SG', 66: 'TH', 81: 'JP', 82: 'KR', 84: 'VN', 86: 'CN', 90: 'TR',
  91: 'IN', 92: 'PK', 93: 'AF', 94: 'LK', 95: 'MM', 98: 'IR',
  211: 'SS', 212: 'MA', 213: 'DZ', 216: 'TN', 218: 'LY', 220: 'GM', 221: 'SN',
  222: 'MR', 223: 'ML', 224: 'GN', 225: 'CI', 226: 'BF', 227: 'NE', 228: 'TG',
  229: 'BJ', 230: 'MU', 231: 'LR', 232: 'SL', 233: 'GH', 234: 'NG', 235: 'TD',
  236: 'CF', 237: 'CM', 238: 'CV', 239: 'ST', 240: 'GQ', 241: 'GA', 242: 'CG',
  243: 'CD', 244: 'AO', 245: 'GW', 248: 'SC', 249: 'SD', 250: 'RW', 251: 'ET',
  252: 'SO', 253: 'DJ', 254: 'KE', 255: 'TZ', 256: 'UG', 257: 'BI', 258: 'MZ',
  260: 'ZM', 261: 'MG', 263: 'ZW', 264: 'NA', 265: 'MW', 266: 'LS', 267: 'BW',
  268: 'SZ', 269: 'KM',
  297: 'AW', 298: 'FO', 299: 'GL',
  350: 'GI', 351: 'PT', 352: 'LU', 353: 'IE', 354: 'IS', 355: 'AL', 356: 'MT',
  357: 'CY', 358: 'FI', 359: 'BG', 370: 'LT', 371: 'LV', 372: 'EE', 373: 'MD',
  374: 'AM', 375: 'BY', 376: 'AD', 377: 'MC', 378: 'SM', 380: 'UA', 381: 'RS',
  382: 'ME', 383: 'XK', 385: 'HR', 386: 'SI', 387: 'BA', 389: 'MK',
  420: 'CZ', 421: 'SK', 423: 'LI',
  500: 'FK', 501: 'BZ', 502: 'GT', 503: 'SV', 504: 'HN', 505: 'NI', 506: 'CR',
  // 51 (PE) is deliberately absent here — it is declared with the other
  // two-digit codes above. It appeared in this 5xx block too, where the
  // duplicate key silently overwrote the first with the same value.
  507: 'PA', 509: 'HT', 591: 'BO', 592: 'GY', 593: 'EC', 595: 'PY',
  597: 'SR', 598: 'UY',
  670: 'TL', 673: 'BN', 674: 'NR', 675: 'PG', 676: 'TO', 677: 'SB', 678: 'VU',
  679: 'FJ', 680: 'PW', 682: 'CK', 685: 'WS', 686: 'KI', 689: 'PF',
  690: 'TK', 691: 'FM', 692: 'MH',
  850: 'KP', 852: 'HK', 853: 'MO', 855: 'KH', 856: 'LA',
  880: 'BD', 886: 'TW',
  960: 'MV', 961: 'LB', 962: 'JO', 963: 'SY', 964: 'IQ', 965: 'KW', 966: 'SA',
  967: 'YE', 968: 'OM', 970: 'PS', 971: 'AE', 972: 'IL', 973: 'BH', 974: 'QA',
  975: 'BT', 976: 'MN', 977: 'NP', 992: 'TJ', 993: 'TM', 994: 'AZ', 995: 'GE',
  996: 'KG', 998: 'UZ',
};

/**
 * @returns {{cc: string, country: string}|{cc: null, country: null}}
 * Longest match wins so 91 (India) never shadows 972 (Israel) etc.
 */
function resolveCountry(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { cc: null, country: null };
  for (let len = 4; len >= 1; len--) {
    const prefix = digits.slice(0, len);
    if (prefix && CODES[Number(prefix)] !== undefined && String(Number(prefix)) === prefix) {
      return { cc: prefix, country: CODES[Number(prefix)] };
    }
  }
  return { cc: null, country: null };
}

module.exports = { resolveCountry, CODES };
