// String tables of the demo. Scene code refers to the keys only.
//
// "x-long" is a pseudo-locale: every string is several times longer than the
// English one. It exists to prove that labels size and wrap themselves, and it
// goes through the same pre-render checks as a real language.

import type { StringTables } from 'skink3-engine';

export const strings: StringTables = {
  en: {
    'label.source': 'Source',
    'label.landing': 'Soft landing',
  },
  'x-long': {
    'label.source': 'The place where every single one of the signals begins',
    'label.landing': 'A remarkably soft and unhurried landing for all the pieces',
  },
};
