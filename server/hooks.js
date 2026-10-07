// Događaji iz rezervacija na koje se vežu dodatne mogućnosti (obavijesti, lista čekanja),
// bez da bookings.js mora znati za njih.
import { EventEmitter } from 'node:events';

export const hooks = new EventEmitter();

/** Pokreni sve slušače i pričekaj ih; greška u jednom ne ruši ostale. */
export async function emit(name, ...args) {
  for (const fn of hooks.listeners(name)) {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[${name}]`, err);
    }
  }
}
