// Aritmética de datas da referência: número de dias desde 1970-01-01 (algoritmo de Howard Hinnant), sem usar Date.
// Datas são 'AAAA-MM-DD'. Nada aqui depende do Worker.
export const toDay = s => {
  let [y, m, d] = s.split('-').map(Number);
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const fromDay = z0 => {
  const z = z0 + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
  return `${pad(yoe + era * 400 + (m <= 2 ? 1 : 0), 4)}-${pad(m)}-${pad(d)}`;
};
export const addDays = (s, n) => fromDay(toDay(s) + n);
export const weekday = s => (((toDay(s) + 4) % 7) + 7) % 7; // 0 = domingo (1970-01-01 foi quinta)
const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
// Soma meses mantendo o dia; se o mês de destino é mais curto, usa o último dia dele (31/01 + 1 mês = 28/02).
export const addMonths = (s, n) => {
  const [y, m, d] = s.split('-').map(Number), t = y * 12 + (m - 1) + n, ny = Math.floor(t / 12), nm = t - ny * 12 + 1;
  return `${pad(ny, 4)}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
};
// Meses-calendário: meses completos desde `from` (aniversário mensal) + fração do mês parcial em dias.
export const calendarMonths = (from, to) => {
  if (toDay(to) < toDay(from)) return -calendarMonths(to, from);
  const [y1, m1] = from.split('-').map(Number), [y2, m2] = to.split('-').map(Number);
  let n = (y2 - y1) * 12 + (m2 - m1);
  while (toDay(addMonths(from, n)) > toDay(to)) n--;
  while (toDay(addMonths(from, n + 1)) <= toDay(to)) n++;
  const a = toDay(addMonths(from, n)), b = toDay(addMonths(from, n + 1));
  return n + (toDay(to) - a) / (b - a);
};
// Idade em anos completos.
export const ageYears = (birth, on) => {
  const [y, m, d] = birth.split('-').map(Number), [Y, M, D] = on.split('-').map(Number);
  return Y - y - ((M < m || (M === m && D < d)) ? 1 : 0);
};
export const firstOfMonth = s => s.slice(0, 8) + '01';
